/**
 * @file src/platform/capture_status.h
 * @brief Shared status contract for native audio and video capture backends.
 */
#pragma once

namespace platf {
  /** @brief Result of one native capture operation. */
  enum class capture_e : int {
    ok,  ///< Success.
    reinit,  ///< Backend must be recreated.
    timeout,  ///< No sample available within this capture interval.
    interrupted,  ///< Capture was interrupted.
    error  ///< Capture failed.
  };
}  // namespace platf
