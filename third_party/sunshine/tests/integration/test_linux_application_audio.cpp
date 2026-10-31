/**
 * @file tests/integration/test_linux_application_audio.cpp
 * @brief Opt-in real PulseAudio application-monitor isolation and retirement checks.
 */
#if defined(__linux__)
#include "src/platform/audio_capture.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <gtest/gtest.h>
#include <pulse/simple.h>
#include <signal.h>
#include <spawn.h>
#include <string>
#include <string_view>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

extern char **environ;  ///< Inherited environment containing the isolated PulseAudio socket.

namespace {
  /** @brief Separate playback process used to detect accidental whole-sink capture. */
  class foreign_tone_t {
  public:
    /** @brief Stop and reap only the test-owned child. */
    ~foreign_tone_t() {
      if (pid_ <= 0) {
        return;
      }
      pid_t result;
      do {
        result = waitpid(pid_, nullptr, WNOHANG);
      } while (result < 0 && errno == EINTR);
      if (result == 0) {
        kill(pid_, SIGTERM);
        while (waitpid(pid_, nullptr, 0) < 0 && errno == EINTR) {}
      }
    }

    /** @brief Play a distinct tone into the explicit fixture sink. @param sink Isolated test sink. @return True on launch. */
    bool start(const char *sink) {
      auto file = std::unique_ptr<FILE, decltype(&fclose)>(std::tmpfile(), fclose);
      if (!file) {
        return false;
      }
      for (int frame = 0; frame < 48000 * 5; ++frame) {
        const float value = 0.1f * std::sin(frame * 6.283185307179586 * 1477.0 / 48000.0);
        const float samples[] {value, value};
        if (std::fwrite(samples, sizeof(float), 2, file.get()) != 2) {
          return false;
        }
      }
      std::rewind(file.get());
      std::vector<std::string> arguments {"pacat", "--playback", "--raw", "--rate=48000", "--channels=2",
                                          std::string("--format=") + pa_sample_format_to_string(PA_SAMPLE_FLOAT32NE),
                                          std::string("--device=") + sink};
      std::vector<char *> argv;
      for (auto &argument : arguments) {
        argv.push_back(argument.data());
      }
      argv.push_back(nullptr);
      posix_spawn_file_actions_t actions;
      if (posix_spawn_file_actions_init(&actions) != 0) {
        return false;
      }
      auto redirected = posix_spawn_file_actions_adddup2(&actions, fileno(file.get()), STDIN_FILENO);
      if (redirected == 0 && fileno(file.get()) != STDIN_FILENO) {
        redirected = posix_spawn_file_actions_addclose(&actions, fileno(file.get()));
      }
      pid_t child = -1;
      const auto result = redirected == 0 ? posix_spawnp(&child, "pacat", &actions, nullptr, argv.data(), environ) : redirected;
      posix_spawn_file_actions_destroy(&actions);
      if (result == 0) {
        pid_ = child;
      }
      return result == 0;
    }

  private:
    pid_t pid_ {-1};  ///< Child identity retained until waitpid reaps it.
  };

  /** @brief Measure a tone in one stereo PCM packet. @param samples Interleaved PCM. @param hz Frequency. @return Amplitude. */
  double tone_amplitude(const std::vector<float> &samples, double hz) {
    double real = 0;
    double imaginary = 0;
    const auto frames = samples.size() / 2;
    for (std::size_t frame = 0; frame < frames; ++frame) {
      const auto phase = frame * 6.283185307179586 * hz / 48000.0;
      const auto sample = (samples[frame * 2] + samples[frame * 2 + 1]) * 0.5;
      real += sample * std::cos(phase);
      imaginary += sample * std::sin(phase);
    }
    return 2 * std::hypot(real, imaginary) / frames;
  }

  /** @brief Test launch whose live membership is controlled independently of audio capture. */
  class audio_test_target_t final: public capture::target_t {
  public:
    std::atomic_bool admit {false};  ///< Admit only this test's playback process when enabled.
    std::uint32_t process_id() const override {
      return getpid();
    }
    bool alive() const override {
      return !retired();
    }
    bool contains(std::uint32_t pid) const override {
      return alive() && admit.load() && pid == process_id();
    }
    capture::renderer_ptr renderer() const override {
      return nullptr;
    }
  };

  TEST(LinuxApplicationAudio, RejectsMissingTargetAndUnsupportedLayout) {
    EXPECT_EQ(platf::application_microphone({}, 2, 48000, 960, true), nullptr);
    auto target = std::make_shared<audio_test_target_t>();
    EXPECT_EQ(platf::application_microphone(target, 3, 48000, 960, true), nullptr);
    EXPECT_EQ(platf::application_microphone(target, 2, 48000, 4800, true), nullptr);
    target->retire();
    EXPECT_EQ(platf::application_microphone(target, 2, 48000, 960, true), nullptr);
  }

  TEST(LinuxApplicationAudio, RealMonitorExcludesUnownedAudioAndStopsOnRetirement) {
    const auto enabled = std::getenv("STREAM_KIT_TEST_PULSE_APPLICATION_AUDIO");
    const auto sink = std::getenv("PULSE_SINK");
    if (!enabled || std::string_view(enabled) != "1" || !sink || !*sink) {
      GTEST_SKIP() << "Requires explicit opt-in and an isolated test PULSE_SINK";
    }
    auto target = std::make_shared<audio_test_target_t>();
    auto mic = platf::application_microphone(target, 2, 48000, 960, true);
    ASSERT_NE(mic, nullptr);
    foreign_tone_t foreign;
    ASSERT_TRUE(foreign.start(sink));
    // Prove the competing process really produced its tone before checking isolation.
    {
      const pa_sample_spec spec {PA_SAMPLE_FLOAT32NE, 48000, 2};
      const pa_buffer_attr attr {48000 * 2 * sizeof(float) * 60 / 1000, UINT32_MAX, UINT32_MAX, UINT32_MAX, 960 * 2 * sizeof(float)};
      int error = 0;
      const auto monitor_name = std::string(sink) + ".monitor";
      auto monitor = std::unique_ptr<pa_simple, decltype(&pa_simple_free)>(
        pa_simple_new(nullptr, "stream-kit-test-reference", PA_STREAM_RECORD, monitor_name.c_str(), "fixture-reference", &spec, nullptr, &attr, &error), pa_simple_free
      );
      ASSERT_NE(monitor, nullptr);
      std::vector<float> reference(1920);
      double amplitude = 0;
      for (int i = 0; i < 30; ++i) {
        ASSERT_EQ(pa_simple_read(monitor.get(), reference.data(), reference.size() * sizeof(float), &error), 0);
        amplitude = std::max(amplitude, tone_amplitude(reference, 1477.0));
      }
      ASSERT_GT(amplitude, 0.05) << "Foreign tone was not present; isolation test cannot proceed";
    }
    std::atomic_bool failed {false};
    std::jthread tone([&](std::stop_token stop) {
      const pa_sample_spec spec {PA_SAMPLE_FLOAT32NE, 48000, 2};
      int error = 0;
      auto playback = pa_simple_new(nullptr, "stream-kit-isolation-test", PA_STREAM_PLAYBACK, sink, "test-tone", &spec, nullptr, nullptr, &error);
      if (!playback) {
        failed = true;
        return;
      }
      std::vector<float> samples(1920);
      std::uint64_t frame = 0;
      while (!stop.stop_requested()) {
        for (std::size_t i = 0; i < samples.size(); i += 2, ++frame) {
          samples[i] = samples[i + 1] = 0.1f * std::sin(frame * 6.283185307179586 * 997.0 / 48000.0);
        }
        if (pa_simple_write(playback, samples.data(), samples.size() * sizeof(float), &error) < 0) {
          failed = true;
          break;
        }
      }
      pa_simple_free(playback);
    });
    std::vector<float> samples(1920);
    for (int i = 0; i < 50; ++i) {
      ASSERT_EQ(mic->sample(samples), platf::capture_e::ok);
      for (float value : samples) {
        ASSERT_EQ(value, 0.0f) << "Unowned playback leaked into application capture";
      }
    }
    target->admit = true;
    double energy = 0;
    double owned_amplitude = 0;
    for (int i = 0; i < 100; ++i) {
      ASSERT_EQ(mic->sample(samples), platf::capture_e::ok);
      owned_amplitude = std::max(owned_amplitude, tone_amplitude(samples, 997.0));
      EXPECT_LT(tone_amplitude(samples, 1477.0), 0.02) << "Another process's tone leaked from the shared sink";
      for (float value : samples) {
        energy += value * value;
      }
    }
    EXPECT_FALSE(failed.load());
    EXPECT_GT(energy / (100 * samples.size()), 0.001);
    EXPECT_GT(owned_amplitude, 0.05);
    target->retire();
    EXPECT_EQ(mic->sample(samples), platf::capture_e::error);
    for (float value : samples) {
      EXPECT_EQ(value, 0.0f);
    }
  }
}  // namespace
#endif
