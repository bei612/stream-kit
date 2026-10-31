/**
 * @file src/platform/linux/application_frame.h
 * @brief Application-window pixels independent of the video encoder and display wrapper.
 */
#pragma once

#include "src/capture_target.h"
#include "src/platform/capture_status.h"

#include <span>

namespace platf::x11 {
  /** @brief Client-area capture and root-coordinate geometry. */
  struct application_geometry_t {
    int width {};  ///< Captured client width.
    int height {};  ///< Captured client height.
    int desktop_width {};  ///< X11 root width for input scaling.
    int desktop_height {};  ///< X11 root height for input scaling.
    int x {};  ///< Client origin relative to the X11 root.
    int y {};  ///< Client origin relative to the X11 root.
  };

  /** @brief Owned XComposite pixmap and MIT-SHM buffer for one retained renderer. */
  class application_frame_t {
  public:
    /** @brief Open application-only pixels. @param target Retained launch. @return Source or null; never a desktop source. */
    static std::unique_ptr<application_frame_t> create(const capture::target_ptr &target);
    ~application_frame_t();
    /** @brief Read the initialized dimensions. @return Immutable capture geometry. */
    const application_geometry_t &geometry() const;
    /** @brief Read the exact renderer used for this frame source. @return Retained process/window identity. */
    capture::renderer_ptr renderer() const;
    /** @brief Capture BGRX pixels into an owned video buffer. @param destination Exactly width*height*4 bytes. @param cursor Include the pointer inside the client area. @return Capture status. */
    capture_e read(std::span<std::uint8_t> destination, bool cursor = false);

  private:
    class state_t;  ///< Native X11 and shared-memory resource owner.
    explicit application_frame_t(std::unique_ptr<state_t> state);  ///< Adopt a fully initialized native state.
    std::unique_ptr<state_t> state_;  ///< No native handles escape this owner.
  };
}  // namespace platf::x11
