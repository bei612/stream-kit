/**
 * @file src/capture_input.h
 * @brief Live input geometry for an owned application capture target.
 */
#pragma once

#include <optional>
#include <utility>

#include "capture_target.h"

namespace capture {
  /** @brief Immutable capture dimensions and renderer carried with an input viewport. */
  struct input_viewport_t {
    renderer_ptr renderer;  ///< Exact renderer retained by the video backend.
    int width = 0;  ///< Captured physical pixel width.
    int height = 0;  ///< Captured physical pixel height.
  };

  /**
   * @brief Read the current capture-window origin in virtual desktop pixel coordinates.
   * @param target Retained application identity shared with picture and audio capture.
   * @param viewport Optional captured viewport to validate before accepting coordinates.
   * @return Window origin, or no value when ownership or visibility cannot be verified.
   */
  std::optional<std::pair<int, int>> input_origin(const target_ptr &target, const input_viewport_t *viewport = nullptr);

  /**
   * @brief Check that the retained capture window currently owns keyboard focus.
   * @param target Application identity; missing or unsupported targets are rejected.
   * @return True only for a live, visible renderer matching the foreground window.
   */
  bool input_focused(const target_ptr &target);
}  // namespace capture
