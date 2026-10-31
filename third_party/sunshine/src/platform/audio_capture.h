/**
 * @file src/platform/audio_capture.h
 * @brief Native PCM capture contract, independent of encoders, windows, and server configuration.
 */
#pragma once

#include "src/capture_target.h"
#include "src/platform/capture_status.h"

#include <vector>

namespace platf {
  /** @brief Audio capture source used by the streaming pipeline. */
  class mic_t {
  public:
    /**
     * @brief Deliver a captured audio sample to Sunshine's audio pipeline.
     * @param frame_buffer Destination for captured floating-point PCM samples.
     * @return Capture status reported to the streaming pipeline.
     */
    virtual capture_e sample(std::vector<float> &frame_buffer) = 0;
    virtual ~mic_t() = default;
  };

  /**
   * @brief Capture only the retained application's rendered audio, without changing host endpoints.
   * @param target Retained launch identity shared with video.
   * @param channels Number of output channels.
   * @param sample_rate Requested PCM sample rate.
   * @param frame_size Samples per output frame.
   * @param continuous Whether to emit silence while the application is silent.
   * @return Application-only audio source; null on failure, with no desktop fallback.
   */
  std::unique_ptr<mic_t> application_microphone(const capture::target_ptr &target, int channels, std::uint32_t sample_rate, std::uint32_t frame_size, bool continuous);
}  // namespace platf
