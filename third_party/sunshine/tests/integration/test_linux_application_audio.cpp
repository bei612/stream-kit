/**
 * @file tests/integration/test_linux_application_audio.cpp
 * @brief Opt-in real PulseAudio application-monitor isolation and retirement checks.
 */
#if defined(__linux__)
#include "src/platform/audio_capture.h"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <gtest/gtest.h>
#include <pulse/simple.h>
#include <string_view>
#include <thread>
#include <unistd.h>

namespace {
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
    for (int i = 0; i < 100; ++i) {
      ASSERT_EQ(mic->sample(samples), platf::capture_e::ok);
      for (float value : samples) {
        energy += value * value;
      }
    }
    EXPECT_FALSE(failed.load());
    EXPECT_GT(energy / (100 * samples.size()), 0.001);
    target->retire();
    EXPECT_EQ(mic->sample(samples), platf::capture_e::error);
    for (float value : samples) {
      EXPECT_EQ(value, 0.0f);
    }
  }
}  // namespace
#endif
