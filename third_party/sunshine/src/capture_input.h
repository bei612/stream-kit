/**
 * @file src/capture_input.h
 * @brief Live input geometry for an owned application capture target.
 */
#pragma once

#include <optional>
#include <utility>

#include "capture_target.h"

namespace capture {
  /**
   * @brief Read the current capture-window origin in virtual desktop pixel coordinates.
   * @param target Retained application identity shared with picture and audio capture.
   * @return Window origin, or no value when ownership or visibility cannot be verified.
   */
  std::optional<std::pair<int, int>> input_origin(const target_ptr &target);
}  // namespace capture
