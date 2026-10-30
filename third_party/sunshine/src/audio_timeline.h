/** @file src/audio_timeline.h
 * @brief Bounded PCM timeline reconciliation for timestamped capture packets.
 */
#pragma once

#include <cstdint>
#include <optional>

namespace audio {
  /** @brief Detect missing PCM against packet timestamps, without allocating gap-sized buffers. */
  class capture_timeline_t {
  public:
    /** @brief Configure PCM rate. @param rate Frames per second. */
    explicit capture_timeline_t(std::uint32_t rate): rate_(rate) {}

    /**
     * @brief Account for a packet and return preceding missing frames.
     * @param timestamp First-frame QPC time in 100-nanosecond units.
     * @param frames Packet frame count.
     * @param valid Whether the native timestamp is usable.
     * @return Gap frames; nullopt requests reinitialization for a large discontinuity.
     */
    std::optional<std::uint64_t> accept(std::uint64_t timestamp, std::uint32_t frames, bool valid) {
      if (!valid || !timestamp || !rate_) {
        anchored_ = false;
        return 0;
      }
      if (!anchored_) {
        anchor_ = timestamp;
        frames_ = frames;
        anchored_ = true;
        return 0;
      }
      if (timestamp < anchor_) {
        anchored_ = false;
        return std::nullopt;
      }
      const auto elapsed = timestamp - anchor_;
      // Rebase each accepted packet to avoid long-running integer overflow.
      if (elapsed > 30000000ULL) {
        anchored_ = false;
        return std::nullopt;
      }
      const auto expected = (elapsed * rate_ + 5000000) / 10000000;
      const auto missing = expected > frames_ ? expected - frames_ : 0;
      if (missing > rate_ * 2ULL) {
        anchored_ = false;
        return std::nullopt;
      }
      // Sub-packet scheduling jitter must not accumulate into fabricated PCM.
      const auto gap = missing > rate_ / 50 ? missing : 0;
      anchor_ = timestamp;
      frames_ = frames;
      return gap;
    }

  private:
    std::uint32_t rate_;  ///< Configured PCM frame rate.
    std::uint64_t anchor_ {};  ///< Previous packet timestamp.
    std::uint64_t frames_ {};  ///< Previous packet length.
    bool anchored_ {};  ///< Whether a valid packet established the clock.
  };
}
