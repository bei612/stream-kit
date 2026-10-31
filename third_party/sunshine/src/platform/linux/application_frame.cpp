/**
 * @file src/platform/linux/application_frame.cpp
 * @brief Isolated XComposite window capture with private MIT-SHM storage.
 */
#include "application_frame.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <xcb/composite.h>
#include <xcb/shm.h>
#include <xcb/xfixes.h>

namespace platf::x11 {
  namespace {
    /** @brief Release an XCB reply. */
    struct reply_deleter_t {
      /** @brief Free a protocol response. @param reply Caller-owned reply allocation. */
      void operator()(void *reply) const {
        std::free(reply);
      }
    };
    /** @brief Own a checked XCB response. */
    template<class T>
    using reply_ptr = std::unique_ptr<T, reply_deleter_t>;
  }  // namespace

  /** @brief Native resources kept separate from asynchronous encoder buffers. */
  class application_frame_t::state_t {
  public:
    capture::target_ptr target;  ///< Shared launch authority.
    capture::renderer_ptr renderer;  ///< Exact captured window.
    application_geometry_t geometry;  ///< Client/root dimensions.
    xcb_connection_t *connection {};  ///< Dedicated capture connection.
    xcb_window_t window {};  ///< Client window, never a root drawable.
    xcb_window_t root {};  ///< Root used only for geometry.
    xcb_pixmap_t pixmap {};  ///< Named backing pixmap, including any window border.
    xcb_shm_seg_t segment {};  ///< Server-side shared-memory attachment.
    int shared_id {-1};  ///< Private SysV segment until marked for removal.
    void *memory {reinterpret_cast<void *>(-1)};  ///< Locally attached shared memory.
    std::size_t bytes {};  ///< Exact BGRX output length.
    std::uint16_t border {};  ///< Offset of the client area inside the backing pixmap.
    std::uint8_t depth {};  ///< Initialized X11 drawable depth.
    bool redirected {};  ///< This connection owns an automatic redirect reference.
    bool attached {};  ///< This connection attached the MIT-SHM segment.
    bool cursor_available {};  ///< XFixes cursor protocol negotiated on this connection.

    /** @brief Release only this capture's pixmap, redirect reference, and private memory. */
    ~state_t() {
      if (connection) {
        if (attached) {
          reply_ptr<xcb_generic_error_t> error(xcb_request_check(connection, xcb_shm_detach_checked(connection, segment)));
        }
        if (pixmap) {
          xcb_free_pixmap(connection, pixmap);
        }
        if (redirected) {
          xcb_composite_unredirect_window(connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC);
        }
        xcb_disconnect(connection);
      }
      if (memory != reinterpret_cast<void *>(-1)) {
        shmdt(memory);
      }
      if (shared_id >= 0) {
        shmctl(shared_id, IPC_RMID, nullptr);
      }
    }

    /** @brief Validate a void XCB request without global Xlib error handlers. @param request Request cookie. @return True on success. */
    bool checked(xcb_void_cookie_t request) const {
      reply_ptr<xcb_generic_error_t> error(xcb_request_check(connection, request));
      return !error && !xcb_connection_has_error(connection);
    }

    /** @brief Validate the original process/window and current launch authority. @return True while capture is authorized. */
    bool authorized() const {
      return target && target->alive() && renderer && renderer->alive() && target->contains(renderer->process_id());
    }

    /** @brief Initialize a private backing-pixmap capture. @return True if every native resource is ready. */
    bool init() {
      if (!target || !target->alive()) {
        return false;
      }
      renderer = target->renderer();
      if (!authorized()) {
        return false;
      }
      window = static_cast<xcb_window_t>(renderer->window_handle());
      connection = xcb_connect(nullptr, nullptr);
      if (!connection || xcb_connection_has_error(connection)) {
        return false;
      }
      const auto composite = xcb_get_extension_data(connection, &xcb_composite_id);
      const auto shared = xcb_get_extension_data(connection, &xcb_shm_id);
      if (!composite || !composite->present || !shared || !shared->present) {
        return false;
      }
      reply_ptr<xcb_composite_query_version_reply_t> version(xcb_composite_query_version_reply(connection, xcb_composite_query_version(connection, 0, 4), nullptr));
      if (!version || (version->major_version == 0 && version->minor_version < 2)) {
        return false;
      }
      const auto fixes = xcb_get_extension_data(connection, &xcb_xfixes_id);
      if (fixes && fixes->present) {
        reply_ptr<xcb_xfixes_query_version_reply_t> cursor_version(xcb_xfixes_query_version_reply(connection, xcb_xfixes_query_version(connection, 2, 0), nullptr));
        cursor_available = cursor_version && cursor_version->major_version >= 1;
      }
      reply_ptr<xcb_get_geometry_reply_t> dimensions(xcb_get_geometry_reply(connection, xcb_get_geometry(connection, window), nullptr));
      reply_ptr<xcb_get_window_attributes_reply_t> attributes(xcb_get_window_attributes_reply(connection, xcb_get_window_attributes(connection, window), nullptr));
      if (!dimensions || !attributes || !dimensions->width || !dimensions->height || window == dimensions->root) {
        return false;
      }
      root = dimensions->root;
      depth = dimensions->depth;
      border = dimensions->border_width;
      geometry.width = dimensions->width;
      geometry.height = dimensions->height;
      bytes = static_cast<std::size_t>(geometry.width) * geometry.height * 4;
      if (bytes > 256 * 1024 * 1024) {
        return false;
      }
      const auto setup = xcb_get_setup(connection);
      if (!setup || setup->image_byte_order != XCB_IMAGE_ORDER_LSB_FIRST) {
        return false;
      }
      bool format_ok = false;
      for (auto format = xcb_setup_pixmap_formats_iterator(setup); format.rem; xcb_format_next(&format)) {
        format_ok = format_ok || (format.data->depth == depth && format.data->bits_per_pixel == 32 && format.data->scanline_pad == 32);
      }
      bool visual_ok = false;
      for (auto screen = xcb_setup_roots_iterator(setup); screen.rem; xcb_screen_next(&screen)) {
        for (auto depths = xcb_screen_allowed_depths_iterator(screen.data); depths.rem; xcb_depth_next(&depths)) {
          for (auto visual = xcb_depth_visuals_iterator(depths.data); visual.rem; xcb_visualtype_next(&visual)) {
            visual_ok = visual_ok || (visual.data->visual_id == attributes->visual && visual.data->_class == XCB_VISUAL_CLASS_TRUE_COLOR &&
                                     visual.data->red_mask == 0x00ff0000 && visual.data->green_mask == 0x0000ff00 && visual.data->blue_mask == 0x000000ff);
          }
        }
      }
      if (!format_ok || !visual_ok) {
        return false;
      }
      reply_ptr<xcb_get_geometry_reply_t> desktop(xcb_get_geometry_reply(connection, xcb_get_geometry(connection, root), nullptr));
      reply_ptr<xcb_translate_coordinates_reply_t> origin(xcb_translate_coordinates_reply(connection, xcb_translate_coordinates(connection, window, root, 0, 0), nullptr));
      if (!desktop || !origin || !origin->same_screen) {
        return false;
      }
      geometry.desktop_width = desktop->width;
      geometry.desktop_height = desktop->height;
      geometry.x = origin->dst_x;
      geometry.y = origin->dst_y;
      if (!checked(xcb_composite_redirect_window_checked(connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC))) {
        return false;
      }
      redirected = true;
      pixmap = xcb_generate_id(connection);
      if (!checked(xcb_composite_name_window_pixmap_checked(connection, window, pixmap))) {
        pixmap = XCB_PIXMAP_NONE;
        return false;
      }
      shared_id = shmget(IPC_PRIVATE, bytes, IPC_CREAT | 0600);
      if (shared_id < 0) {
        return false;
      }
      memory = shmat(shared_id, nullptr, 0);
      if (memory == reinterpret_cast<void *>(-1)) {
        return false;
      }
      segment = xcb_generate_id(connection);
      if (!checked(xcb_shm_attach_checked(connection, segment, shared_id, 0))) {
        return false;
      }
      attached = true;
      if (shmctl(shared_id, IPC_RMID, nullptr) != 0) {
        return false;
      }
      shared_id = -1;
      return authorized();
    }

    /** @brief Composite only the pointer portion inside this application's client area. @param destination BGRX output. */
    void draw_cursor(std::span<std::uint8_t> destination) const {
      if (!cursor_available) {
        return;
      }
      reply_ptr<xcb_translate_coordinates_reply_t> origin(xcb_translate_coordinates_reply(connection, xcb_translate_coordinates(connection, window, root, 0, 0), nullptr));
      reply_ptr<xcb_xfixes_get_cursor_image_reply_t> cursor(xcb_xfixes_get_cursor_image_reply(connection, xcb_xfixes_get_cursor_image(connection), nullptr));
      if (!origin || !cursor || cursor->x < origin->dst_x || cursor->y < origin->dst_y ||
          cursor->x >= origin->dst_x + geometry.width || cursor->y >= origin->dst_y + geometry.height) {
        return;
      }
      const int left = cursor->x - cursor->xhot - origin->dst_x;
      const int top = cursor->y - cursor->yhot - origin->dst_y;
      const auto pixels = xcb_xfixes_get_cursor_image_cursor_image(cursor.get());
      for (int y = std::max(0, -top); y < cursor->height && y + top < geometry.height; ++y) {
        for (int x = std::max(0, -left); x < cursor->width && x + left < geometry.width; ++x) {
          const auto color = pixels[y * cursor->width + x];
          const auto alpha = color >> 24;
          const auto offset = (static_cast<std::size_t>(y + top) * geometry.width + x + left) * 4;
          for (int channel = 0; channel < 3; ++channel) {
            destination[offset + channel] = static_cast<std::uint8_t>(std::min<std::uint32_t>(255,
              ((color >> (channel * 8)) & 255) + (destination[offset + channel] * (255 - alpha) + 127) / 255
            ));
          }
        }
      }
    }

    /** @brief Capture the backing pixmap without including overlapping windows. @param destination BGRX output. @param cursor Include the pointer. @return Capture status. */
    capture_e read(std::span<std::uint8_t> destination, bool cursor) {
      if (destination.size() != bytes || !authorized() || xcb_connection_has_error(connection)) {
        std::fill(destination.begin(), destination.end(), 0);
        return capture_e::error;
      }
      reply_ptr<xcb_get_geometry_reply_t> dimensions(xcb_get_geometry_reply(connection, xcb_get_geometry(connection, window), nullptr));
      reply_ptr<xcb_get_geometry_reply_t> desktop(xcb_get_geometry_reply(connection, xcb_get_geometry(connection, root), nullptr));
      if (!dimensions || !desktop) {
        return capture_e::error;
      }
      if (dimensions->width != geometry.width || dimensions->height != geometry.height || dimensions->border_width != border || dimensions->depth != depth ||
          desktop->width != geometry.desktop_width || desktop->height != geometry.desktop_height) {
        return capture_e::reinit;
      }
      reply_ptr<xcb_shm_get_image_reply_t> image(xcb_shm_get_image_reply(connection, xcb_shm_get_image(
        connection, pixmap, border, border, geometry.width, geometry.height, UINT32_MAX, XCB_IMAGE_FORMAT_Z_PIXMAP, segment, 0
      ), nullptr));
      if (!image || image->depth != depth || image->size != bytes) {
        return capture_e::reinit;
      }
      if (!authorized()) {
        std::fill(destination.begin(), destination.end(), 0);
        return capture_e::error;
      }
      std::memcpy(destination.data(), memory, bytes);
      if (cursor) {
        draw_cursor(destination);
      }
      if (!authorized()) {
        std::fill(destination.begin(), destination.end(), 0);
        return capture_e::error;
      }
      return capture_e::ok;
    }
  };

  application_frame_t::application_frame_t(std::unique_ptr<state_t> state):
      state_(std::move(state)) {}

  application_frame_t::~application_frame_t() = default;

  std::unique_ptr<application_frame_t> application_frame_t::create(const capture::target_ptr &target) {
    auto state = std::make_unique<state_t>();
    state->target = target;
    if (!state->init()) {
      return nullptr;
    }
    return std::unique_ptr<application_frame_t>(new application_frame_t(std::move(state)));
  }

  const application_geometry_t &application_frame_t::geometry() const {
    return state_->geometry;
  }

  capture::renderer_ptr application_frame_t::renderer() const {
    return state_->renderer;
  }

  capture_e application_frame_t::read(std::span<std::uint8_t> destination, bool cursor) {
    return state_->read(destination, cursor);
  }
}  // namespace platf::x11
