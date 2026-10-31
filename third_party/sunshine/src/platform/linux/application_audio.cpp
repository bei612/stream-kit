/**
 * @file src/platform/linux/application_audio.cpp
 * @brief Application-only PulseAudio capture using individual sink-input monitors.
 */
#include "src/platform/audio_capture.h"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <deque>
#include <map>
#include <pulse/pulseaudio.h>
#include <string_view>
#include <thread>

namespace platf {
  namespace {
    using clock_t = std::chrono::steady_clock;  ///< Monotonic capture clock.

    /** @brief One capture owner; all PulseAudio callbacks run on the sampling thread. */
    class application_audio_t final: public mic_t {
      /** @brief One explicitly selected playback stream and its bounded PCM queue. */
      struct track_t {
        application_audio_t *owner {};  ///< Owning capture session.
        std::uint32_t pid {};  ///< Playback process validated against the retained launch.
        std::uint32_t sink {};  ///< Sink containing this playback stream.
        std::uint32_t index {};  ///< Explicit sink-input index; never a whole-sink monitor.
        pa_stream *stream {};  ///< Owned recording stream.
        pa_operation *query {};  ///< Outstanding monitor-source lookup.
        std::deque<float> samples;  ///< At most 60 ms of recent PCM.
        bool seen {};  ///< Present in the latest completed enumeration.

        /** @brief Cancel callbacks before releasing their userdata and recording stream. */
        ~track_t() {
          if (query) {
            pa_operation_cancel(query);
            pa_operation_unref(query);
          }
          if (stream) {
            pa_stream_disconnect(stream);
            pa_stream_unref(stream);
          }
        }
      };

    public:
      /**
       * @brief Retain launch authority and requested PCM layout.
       * @param target Application identity shared with video.
       * @param channels Output channel count.
       * @param rate Output sample rate.
       * @param frames Samples per channel per capture call.
       * @param continuous Whether idle calls produce silence.
       */
      application_audio_t(capture::target_ptr target, int channels, std::uint32_t rate, std::uint32_t frames, bool continuous):
          target_(std::move(target)),
          spec_ {PA_SAMPLE_FLOAT32NE, rate, static_cast<std::uint8_t>(channels)},
          frames_(frames),
          continuous_(continuous) {}

      /** @brief Release streams before their context and event loop. */
      ~application_audio_t() override {
        if (enumeration_) {
          pa_operation_cancel(enumeration_);
          pa_operation_unref(enumeration_);
        }
        tracks_.clear();
        if (context_) {
          pa_context_disconnect(context_);
          pa_context_unref(context_);
        }
        if (loop_) {
          pa_mainloop_free(loop_);
        }
      }

      /** @brief Connect to the user's audio server with a bounded deadline. @return True on success. */
      bool init() {
        if (!target_ || !target_->alive() || !pa_sample_spec_valid(&spec_) || !frames_ || frames_ > spec_.rate) {
          return false;
        }
        loop_ = pa_mainloop_new();
        if (!loop_) {
          return false;
        }
        context_ = pa_context_new(pa_mainloop_get_api(loop_), "stream-kit-application-audio");
        if (!context_ || pa_context_connect(context_, nullptr, PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0) {
          return false;
        }
        const auto deadline = clock_t::now() + std::chrono::seconds(2);
        while (pa_context_get_state(context_) != PA_CONTEXT_READY) {
          if (!PA_CONTEXT_IS_GOOD(pa_context_get_state(context_)) || clock_t::now() >= deadline || !target_->alive() || !pump()) {
            return false;
          }
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        next_frame_ = clock_t::now();
        return true;
      }

      capture_e sample(std::vector<float> &buffer) override {
        std::fill(buffer.begin(), buffer.end(), 0.0f);
        if (buffer.size() != static_cast<std::size_t>(frames_) * spec_.channels || !target_->alive()) {
          std::fill(buffer.begin(), buffer.end(), 0.0f);
          tracks_.clear();
          return capture_e::error;
        }
        std::this_thread::sleep_until(next_frame_);
        const auto now = clock_t::now();
        if (now - next_frame_ > std::chrono::milliseconds(60)) {
          // Reopen monitors after a stalled consumer; buffered server audio is stale too.
          tracks_.clear();
          next_scan_ = now;
        }
        next_frame_ = std::max(next_frame_, now) + std::chrono::nanoseconds(1000000000ULL * frames_ / spec_.rate);
        if (!pump() || pa_context_get_state(context_) != PA_CONTEXT_READY || !target_->alive()) {
          tracks_.clear();
          return capture_e::error;
        }
        if (enumeration_ && pa_operation_get_state(enumeration_) != PA_OPERATION_RUNNING) {
          pa_operation_unref(enumeration_);
          enumeration_ = nullptr;
        }
        if (!enumeration_ && now >= next_scan_) {
          for (auto &[index, track] : tracks_) {
            track->seen = false;
          }
          enumeration_ = pa_context_get_sink_input_info_list(context_, enumerate, this);
          if (!enumeration_) {
            return capture_e::error;
          }
          next_scan_ = now + std::chrono::milliseconds(250);
        }
        std::fill(buffer.begin(), buffer.end(), 0.0f);
        bool available = false;
        for (auto it = tracks_.begin(); it != tracks_.end();) {
          auto &track = *it->second;
          if (!target_->contains(track.pid) || (track.stream && !PA_STREAM_IS_GOOD(pa_stream_get_state(track.stream)))) {
            it = tracks_.erase(it);
            continue;
          }
          const auto count = std::min(buffer.size(), track.samples.size());
          available = available || count != 0;
          for (std::size_t i = 0; i < count; ++i) {
            buffer[i] += track.samples.front();
            track.samples.pop_front();
          }
          ++it;
        }
        for (auto &sample : buffer) {
          sample = std::clamp(sample, -1.0f, 1.0f);
        }
        if (!target_->alive()) {
          std::fill(buffer.begin(), buffer.end(), 0.0f);
          tracks_.clear();
          return capture_e::error;
        }
        return available || continuous_ ? capture_e::ok : capture_e::timeout;
      }

    private:
      /** @brief Service ready callbacks without waiting on audio-server IO. @return False on loop failure. */
      bool pump() {
        return pa_mainloop_iterate(loop_, 0, nullptr) >= 0;
      }

      /** @brief Enumerate playback streams and retain only members of the selected application. */
      static void enumerate(pa_context *, const pa_sink_input_info *info, int eol, void *userdata) {
        auto &self = *static_cast<application_audio_t *>(userdata);
        if (eol) {
          // Failed enumeration cannot preserve previously authorized audio indefinitely.
          std::erase_if(self.tracks_, [eol](const auto &entry) { return eol < 0 || !entry.second->seen; });
          return;
        }
        if (!info || !info->proplist) {
          return;
        }
        const auto pid_text = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_PROCESS_ID);
        std::uint32_t pid = 0;
        if (!pid_text) {
          return;
        }
        const std::string_view text(pid_text);
        const auto parsed = std::from_chars(text.data(), text.data() + text.size(), pid);
        if (parsed.ec != std::errc() || parsed.ptr != text.data() + text.size() || !self.target_->contains(pid)) {
          return;
        }
        auto previous = self.tracks_.find(info->index);
        if (previous != self.tracks_.end()) {
          const auto &existing = *previous->second;
          const bool opening = existing.query && pa_operation_get_state(existing.query) == PA_OPERATION_RUNNING;
          if (existing.pid == pid && existing.sink == info->sink && (existing.stream || opening)) {
            previous->second->seen = true;
            return;
          }
          self.tracks_.erase(previous);
        }
        if (self.tracks_.size() >= 64) {
          return;
        }
        auto track = std::make_unique<track_t>();
        track->owner = &self;
        track->pid = pid;
        track->sink = info->sink;
        track->index = info->index;
        track->seen = true;
        track->query = pa_context_get_sink_info_by_index(self.context_, info->sink, monitor, track.get());
        if (track->query) {
          self.tracks_.emplace(info->index, std::move(track));
        }
      }

      /** @brief Connect an explicit per-stream monitor; never fall back to the sink's mixed audio. */
      static void monitor(pa_context *, const pa_sink_info *info, int, void *userdata) {
        auto &track = *static_cast<track_t *>(userdata);
        auto &self = *track.owner;
        if (!info || !info->monitor_source_name || track.stream || !self.target_->contains(track.pid)) {
          return;
        }
        pa_channel_map map;
        if (!pa_channel_map_init_auto(&map, self.spec_.channels, PA_CHANNEL_MAP_WAVEEX)) {
          return;
        }
        track.stream = pa_stream_new(self.context_, "application-only", &self.spec_, &map);
        if (!track.stream) {
          return;
        }
        pa_buffer_attr attr {UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX,
                             self.frames_ * self.spec_.channels * static_cast<std::uint32_t>(sizeof(float))};
        pa_stream_set_read_callback(track.stream, read, &track);
        if (pa_stream_set_monitor_stream(track.stream, track.index) < 0 ||
            pa_stream_connect_record(track.stream, info->monitor_source_name, &attr, PA_STREAM_ADJUST_LATENCY) < 0) {
          pa_stream_disconnect(track.stream);
          pa_stream_unref(track.stream);
          track.stream = nullptr;
          track.seen = false;
        }
      }

      /** @brief Copy available PCM into a bounded queue; holes become silence. */
      static void read(pa_stream *stream, std::size_t, void *userdata) {
        auto &track = *static_cast<track_t *>(userdata);
        const void *data = nullptr;
        std::size_t bytes = 0;
        if (pa_stream_peek(stream, &data, &bytes) < 0 || !bytes) {
          return;
        }
        const auto limit = static_cast<std::size_t>(track.owner->spec_.rate) * track.owner->spec_.channels * 60 / 1000;
        const auto count = bytes / sizeof(float);
        const auto *samples = static_cast<const float *>(data);
        for (std::size_t i = count > limit ? count - limit : 0; i < count; ++i) {
          if (track.samples.size() >= limit) {
            track.samples.pop_front();
          }
          track.samples.push_back(samples && std::isfinite(samples[i]) ? samples[i] : 0.0f);
        }
        pa_stream_drop(stream);
      }

      capture::target_ptr target_;  ///< Shared launch authorization, never inferred from a sink name.
      pa_sample_spec spec_;  ///< PCM negotiated with PulseAudio.
      std::uint32_t frames_;  ///< Frames in one Sunshine packet.
      bool continuous_;  ///< Whether idle capture emits timed silence.
      pa_mainloop *loop_ {};  ///< Single-threaded PulseAudio event loop.
      pa_context *context_ {};  ///< User-session connection.
      pa_operation *enumeration_ {};  ///< At most one in-flight playback enumeration.
      std::map<std::uint32_t, std::unique_ptr<track_t>> tracks_;  ///< Bounded active playback monitors.
      clock_t::time_point next_frame_ {};  ///< Capture pacing deadline.
      clock_t::time_point next_scan_ {};  ///< Playback discovery deadline.
    };
  }  // namespace

  std::unique_ptr<mic_t> application_microphone(const capture::target_ptr &target, int channels, std::uint32_t sample_rate, std::uint32_t frame_size, bool continuous) {
    if (channels != 2 && channels != 6 && channels != 8) {
      return nullptr;
    }
    auto mic = std::make_unique<application_audio_t>(target, channels, sample_rate, frame_size, continuous);
    return mic->init() ? std::move(mic) : nullptr;
  }
}  // namespace platf
