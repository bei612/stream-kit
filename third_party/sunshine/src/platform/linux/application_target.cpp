/**
 * @file src/platform/linux/application_target.cpp
 * @brief Retained Linux launch identities shared by application audio and video.
 */
#include "src/capture_input.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cerrno>
#include <chrono>
#include <filesystem>
#include <fcntl.h>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unistd.h>
#include <vector>

#ifdef SUNSHINE_BUILD_X11
  #include <cstdlib>
  #include <xcb/res.h>
  #include <xcb/xcb.h>
#endif

namespace capture {
  namespace {
    /** @brief An open procfs record continues to refer to the original task after PID reuse. */
    class process_identity_t {
    public:
      /** @brief Open a process record without following links. @param pid Process to retain. */
      explicit process_identity_t(std::uint32_t pid):
          pid_(pid),
          fd_(open(("/proc/" + std::to_string(pid) + "/stat").c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW)) {}

      /** @brief Release the identity without signalling or reaping the process. */
      ~process_identity_t() {
        if (fd_ >= 0) {
          close(fd_);
        }
      }

      process_identity_t(const process_identity_t &) = delete;
      process_identity_t &operator=(const process_identity_t &) = delete;

      /** @brief Read current membership from the retained task. @return Group, or no value after exit or read failure. */
      std::optional<std::uint32_t> group() const {
        std::array<char, 4096> buffer {};
        ssize_t length;
        do {
          length = fd_ < 0 ? -1 : pread(fd_, buffer.data(), buffer.size(), 0);
        } while (fd_ >= 0 && length < 0 && errno == EINTR);
        if (length <= 0 || static_cast<std::size_t>(length) == buffer.size()) {
          return std::nullopt;
        }
        std::string_view text(buffer.data(), length);
        const auto name = text.find(" (");
        const auto end_name = text.rfind(") ");
        if (name == std::string_view::npos || end_name == std::string_view::npos || end_name <= name) {
          return std::nullopt;
        }
        std::uint32_t pid = 0;
        const auto parsed_pid = std::from_chars(text.data(), text.data() + name, pid);
        if (parsed_pid.ec != std::errc() || parsed_pid.ptr != text.data() + name || pid != pid_) {
          return std::nullopt;
        }
        text.remove_prefix(end_name + 2);
        if (text.size() < 3 || text[1] != ' ' || text[0] == 'Z' || text[0] == 'X' || text[0] == 'x') {
          return std::nullopt;
        }
        text.remove_prefix(2);
        // Field 4 is the parent PID; field 5 is the process group. The command
        // name may contain spaces and parentheses, so splitting the whole line is invalid.
        for (int field = 4; field <= 5; ++field) {
          const auto end = text.find(' ');
          if (end == std::string_view::npos) {
            return std::nullopt;
          }
          std::uint32_t value = 0;
          const auto parsed = std::from_chars(text.data(), text.data() + end, value);
          if (parsed.ec != std::errc() || parsed.ptr != text.data() + end) {
            return std::nullopt;
          }
          if (field == 5) {
            return value > 1 ? std::make_optional(value) : std::nullopt;
          }
          text.remove_prefix(end + 1);
        }
        return std::nullopt;
      }

    private:
      std::uint32_t pid_;  ///< Original task identifier, checked against each procfs read.
      int fd_;  ///< Owned procfs file; never reopened by numeric PID.
    };

#ifdef SUNSHINE_BUILD_X11
    /** @brief Release replies allocated by libxcb. */
    struct reply_deleter_t {
      /** @brief Release a protocol reply. @param reply XCB-owned allocation transferred to the caller. */
      void operator()(void *reply) const {
        std::free(reply);
      }
    };

    /** @brief Owned XCB response; protocol errors yield a null response. */
    template<class T>
    using reply_ptr = std::unique_ptr<T, reply_deleter_t>;
    using connection_ptr = std::shared_ptr<xcb_connection_t>;  ///< Thread-safe XCB connection retained by selected renderers.

    /** @brief Query the X server's actual local client PID, never the client-written _NET_WM_PID property.
     * @param connection Local X11 connection. @param window Window to validate. @return OS PID, or zero when unavailable.
     */
    std::uint32_t window_pid(xcb_connection_t *connection, xcb_window_t window) {
      const xcb_res_client_id_spec_t specification {window, XCB_RES_CLIENT_ID_MASK_LOCAL_CLIENT_PID};
      reply_ptr<xcb_res_query_client_ids_reply_t> reply(xcb_res_query_client_ids_reply(
        connection, xcb_res_query_client_ids(connection, 1, &specification), nullptr
      ));
      if (!reply) {
        return 0;
      }
      auto values = xcb_res_query_client_ids_ids_iterator(reply.get());
      while (values.rem) {
        if ((values.data->spec.mask & XCB_RES_CLIENT_ID_MASK_LOCAL_CLIENT_PID) && xcb_res_client_id_value_value_length(values.data) == 1) {
          return *xcb_res_client_id_value_value(values.data);
        }
        xcb_res_client_id_value_next(&values);
      }
      return 0;
    }

    /** @brief X11 renderer retained together with its original process record and connection. */
    class linux_renderer_t final: public renderer_t {
    public:
      /** @brief Retain a verified window. @param connection X11 connection. @param window Client window.
       * @param pid Owning process. @param group Authorized launch group. @param process Retained OS identity.
       */
      linux_renderer_t(connection_ptr connection, xcb_window_t window, std::uint32_t pid, std::uint32_t group, std::shared_ptr<process_identity_t> process):
          connection_(std::move(connection)),
          window_(window),
          pid_(pid),
          group_(group),
          process_(std::move(process)) {}

      std::uint32_t process_id() const override {
        return pid_;
      }

      std::uintptr_t window_handle() const override {
        return window_;
      }

      bool alive() const override {
        if (xcb_connection_has_error(connection_.get()) || process_->group() != group_) {
          return false;
        }
        reply_ptr<xcb_get_window_attributes_reply_t> attributes(xcb_get_window_attributes_reply(
          connection_.get(), xcb_get_window_attributes(connection_.get(), window_), nullptr
        ));
        return attributes && attributes->map_state == XCB_MAP_STATE_VIEWABLE &&
               window_pid(connection_.get(), window_) == pid_ && process_->group() == group_;
      }

      /** @brief Resolve the client-area input origin for the exact captured dimensions.
       * @param viewport Optional video snapshot to compare. @return Root-relative coordinates, or no value for a stale/hidden window.
       */
      std::optional<std::pair<int, int>> origin(const input_viewport_t *viewport) const {
        if (!alive()) {
          return std::nullopt;
        }
        reply_ptr<xcb_get_geometry_reply_t> geometry(xcb_get_geometry_reply(connection_.get(), xcb_get_geometry(connection_.get(), window_), nullptr));
        if (!geometry || !geometry->width || !geometry->height ||
            (viewport && (viewport->width != geometry->width || viewport->height != geometry->height))) {
          return std::nullopt;
        }
        reply_ptr<xcb_translate_coordinates_reply_t> coordinates(xcb_translate_coordinates_reply(connection_.get(), xcb_translate_coordinates(
          connection_.get(), window_, geometry->root, 0, 0
        ), nullptr));
        if (!coordinates || !coordinates->same_screen || !alive()) {
          return std::nullopt;
        }
        return std::pair<int, int> {coordinates->dst_x, coordinates->dst_y};
      }

      /** @brief Check keyboard focus on the selected window or one of its child widgets. @return True for an owned focused window. */
      bool focused() const {
        if (!alive()) {
          return false;
        }
        reply_ptr<xcb_get_input_focus_reply_t> focus(xcb_get_input_focus_reply(connection_.get(), xcb_get_input_focus(connection_.get()), nullptr));
        if (!focus) {
          return false;
        }
        auto window = focus->focus;
        for (int depth = 0; window > XCB_INPUT_FOCUS_POINTER_ROOT && depth < 64; ++depth) {
          if (window == window_) {
            return alive();
          }
          reply_ptr<xcb_query_tree_reply_t> tree(xcb_query_tree_reply(connection_.get(), xcb_query_tree(connection_.get(), window), nullptr));
          if (!tree || tree->parent == window) {
            return false;
          }
          window = tree->parent;
        }
        return false;
      }

    private:
      connection_ptr connection_;  ///< Renderer keeps the connection alive across backend reinitialization.
      xcb_window_t window_;  ///< Client window, never the desktop root.
      std::uint32_t pid_;  ///< Process verified by the X-Resource extension.
      std::uint32_t group_;  ///< Owning launch group.
      std::shared_ptr<process_identity_t> process_;  ///< Rejects exited/reused process identities.
    };
#endif

    /** @brief Launch group authorized by retained live members, never by a recycled group number alone. */
    class linux_target_t final: public target_t {
    public:
      /** @brief Adopt the launch root. @param pid Root/group leader. @param root Verified retained root. */
      linux_target_t(std::uint32_t pid, std::shared_ptr<process_identity_t> root):
          pid_(pid) {
        members_.emplace(pid, std::move(root));
      }

      std::uint32_t process_id() const override {
        return pid_;
      }

      bool alive() const override {
        std::lock_guard lock(mutex_);
        refresh();
        return !retired() && anchor() != nullptr;
      }

      bool contains(std::uint32_t pid) const override {
        std::lock_guard lock(mutex_);
        if (retired() || pid <= 1 || pid > static_cast<std::uint32_t>(std::numeric_limits<pid_t>::max())) {
          return false;
        }
        const auto retained = anchor();
        if (!retained) {
          return false;
        }
        const auto found = members_.find(pid);
        if (found != members_.end()) {
          return found->second->group() == pid_ && retained->group() == pid_ && !retired();
        }
        auto candidate = std::make_shared<process_identity_t>(pid);
        if (members_.size() >= 4096 || candidate->group() != pid_ || retained->group() != pid_ || retired()) {
          return false;
        }
        members_.emplace(pid, std::move(candidate));
        return true;
      }

      renderer_ptr renderer() const override {
#ifdef SUNSHINE_BUILD_X11
        std::lock_guard lock(renderer_mutex_);
        if (retired()) {
          return nullptr;
        }
        if (renderer_ && renderer_->alive() && contains(renderer_->process_id())) {
          return renderer_;
        }
        renderer_.reset();
        const auto now = std::chrono::steady_clock::now();
        if (now < next_window_scan_) {
          return nullptr;
        }
        next_window_scan_ = now + std::chrono::milliseconds(250);
        if (!connection_ || xcb_connection_has_error(connection_.get())) {
          root_window_ = XCB_WINDOW_NONE;
          int screen = 0;
          connection_.reset(xcb_connect(nullptr, &screen), xcb_disconnect);
          if (!connection_ || xcb_connection_has_error(connection_.get())) {
            return nullptr;
          }
          const auto extension = xcb_get_extension_data(connection_.get(), &xcb_res_id);
          if (!extension || !extension->present) {
            return nullptr;
          }
          // Local client PID queries were introduced in X-Resource 1.2.
          reply_ptr<xcb_res_query_version_reply_t> version(xcb_res_query_version_reply(
            connection_.get(), xcb_res_query_version(connection_.get(), 1, 2), nullptr
          ));
          if (!version || version->server_major < 1 || (version->server_major == 1 && version->server_minor < 2)) {
            return nullptr;
          }
          auto roots = xcb_setup_roots_iterator(xcb_get_setup(connection_.get()));
          for (; screen > 0 && roots.rem; --screen) {
            xcb_screen_next(&roots);
          }
          if (!roots.rem) {
            return nullptr;
          }
          root_window_ = roots.data->root;
        }
        if (root_window_ == XCB_WINDOW_NONE) {
          return nullptr;
        }
        std::vector<xcb_window_t> windows;
        constexpr std::string_view property_name = "_NET_CLIENT_LIST";
        reply_ptr<xcb_intern_atom_reply_t> property(xcb_intern_atom_reply(connection_.get(), xcb_intern_atom(
          connection_.get(), 1, property_name.size(), property_name.data()
        ), nullptr));
        if (property && property->atom != XCB_ATOM_NONE) {
          reply_ptr<xcb_get_property_reply_t> clients(xcb_get_property_reply(connection_.get(), xcb_get_property(
            connection_.get(), 0, root_window_, property->atom, XCB_ATOM_WINDOW, 0, 4096
          ), nullptr));
          if (clients && clients->format == 32 && clients->type == XCB_ATOM_WINDOW) {
            const auto count = xcb_get_property_value_length(clients.get()) / sizeof(xcb_window_t);
            const auto *data = static_cast<const xcb_window_t *>(xcb_get_property_value(clients.get()));
            if (count) {
              windows.assign(data, data + count);
            }
          }
        }
        if (windows.empty()) {
          // A headless X server may have no window manager publishing EWMH state.
          reply_ptr<xcb_query_tree_reply_t> tree(xcb_query_tree_reply(connection_.get(), xcb_query_tree(connection_.get(), root_window_), nullptr));
          if (tree) {
            const auto count = std::min(xcb_query_tree_children_length(tree.get()), 4096);
            const auto *data = xcb_query_tree_children(tree.get());
            if (count > 0) {
              windows.assign(data, data + count);
            }
          }
        }
        std::uint64_t largest = 0;
        for (const auto window : windows) {
          if (window == root_window_) {
            continue;
          }
          const auto pid = window_pid(connection_.get(), window);
          if (!contains(pid)) {
            continue;
          }
          reply_ptr<xcb_get_window_attributes_reply_t> attributes(xcb_get_window_attributes_reply(connection_.get(), xcb_get_window_attributes(connection_.get(), window), nullptr));
          reply_ptr<xcb_get_geometry_reply_t> geometry(xcb_get_geometry_reply(connection_.get(), xcb_get_geometry(connection_.get(), window), nullptr));
          if (!attributes || !geometry || attributes->override_redirect || attributes->_class != XCB_WINDOW_CLASS_INPUT_OUTPUT || attributes->map_state != XCB_MAP_STATE_VIEWABLE) {
            continue;
          }
          const auto area = static_cast<std::uint64_t>(geometry->width) * geometry->height;
          if (area <= largest) {
            continue;
          }
          auto process = std::make_shared<process_identity_t>(pid);
          auto candidate = std::make_shared<linux_renderer_t>(connection_, window, pid, pid_, std::move(process));
          if (candidate->alive() && contains(pid) && !retired()) {
            renderer_ = std::move(candidate);
            largest = area;
          }
        }
        return !retired() ? renderer_ : nullptr;
#else
        return nullptr;
#endif
      }

    private:
      /** @brief Find a retained live group member. @return Stable task identity, or null when group continuity is lost. */
      std::shared_ptr<process_identity_t> anchor() const {
        for (const auto &[pid, identity] : members_) {
          if (identity->group() == pid_) {
            return identity;
          }
        }
        return nullptr;
      }

      /** @brief Discover children while a retained group member still proves launch continuity. */
      void refresh() const {
        if (retired()) {
          members_.clear();
          return;
        }
        const auto now = std::chrono::steady_clock::now();
        if (now < next_scan_) {
          return;
        }
        next_scan_ = now + std::chrono::milliseconds(250);
        std::erase_if(members_, [this](const auto &entry) { return entry.second->group() != pid_; });
        auto retained = anchor();
        if (!retained) {
          return;
        }
        std::error_code error;
        std::filesystem::directory_iterator entries("/proc", error);
        const std::filesystem::directory_iterator end;
        std::size_t visited = 0;
        for (; !error && entries != end && visited < 65536 && members_.size() < 4096; entries.increment(error), ++visited) {
          const auto name = entries->path().filename().string();
          std::uint32_t pid = 0;
          const auto parsed = std::from_chars(name.data(), name.data() + name.size(), pid);
          if (parsed.ec != std::errc() || parsed.ptr != name.data() + name.size() || pid <= 1 || members_.contains(pid)) {
            continue;
          }
          auto candidate = std::make_shared<process_identity_t>(pid);
          if (candidate->group() != pid_) {
            continue;
          }
          if (retired() || retained->group() != pid_) {
            return;
          }
          members_.emplace(pid, candidate);
          // A live child can keep proving continuity after its launcher exits.
          retained = std::move(candidate);
        }
      }

      std::uint32_t pid_;  ///< Original launch PID and isolated process-group ID.
      mutable std::mutex mutex_;  ///< Serializes membership discovery and authorization.
      mutable std::map<std::uint32_t, std::shared_ptr<process_identity_t>> members_;  ///< Retained tasks; bounded to 4096.
      mutable std::chrono::steady_clock::time_point next_scan_ {};  ///< Limits procfs enumeration to four scans per second.
#ifdef SUNSHINE_BUILD_X11
      mutable std::mutex renderer_mutex_;  ///< Serializes stable renderer selection independently of process membership.
      mutable connection_ptr connection_;  ///< Local X server connection, never selected by a web client.
      mutable xcb_window_t root_window_ {};  ///< Root used only for enumerating client windows.
      mutable renderer_ptr renderer_;  ///< Stable renderer until its window or owning task becomes invalid.
      mutable std::chrono::steady_clock::time_point next_window_scan_ {};  ///< Bounds discovery while the application starts.
#endif
    };
  }  // namespace

  target_ptr bind_application(std::uint32_t pid, std::uintptr_t process_handle, std::uintptr_t group_handle) {
    // Boost.Process uses PID-valued native handles on Linux. Only an isolated
    // group led by this launch may authorize application capture.
    if (pid <= 1 || pid > static_cast<std::uint32_t>(std::numeric_limits<pid_t>::max()) ||
        process_handle != pid || group_handle != pid || pid == static_cast<std::uint32_t>(getpgrp())) {
      return nullptr;
    }
    auto root = std::make_shared<process_identity_t>(pid);
    if (root->group() != pid) {
      return nullptr;
    }
    auto target = std::make_shared<linux_target_t>(pid, std::move(root));
    return target->alive() ? target : nullptr;
  }

  std::optional<std::pair<int, int>> input_origin([[maybe_unused]] const target_ptr &target, [[maybe_unused]] const input_viewport_t *viewport) {
#ifdef SUNSHINE_BUILD_X11
    if (!target || !target->alive()) {
      return std::nullopt;
    }
    const auto renderer = target->renderer();
    const auto window = std::dynamic_pointer_cast<linux_renderer_t>(renderer);
    if (!window || (viewport && viewport->renderer != renderer) || !target->contains(window->process_id())) {
      return std::nullopt;
    }
    const auto origin = window->origin(viewport);
    return target->alive() && target->contains(window->process_id()) ? origin : std::nullopt;
#else
    return std::nullopt;
#endif
  }

  bool input_focused([[maybe_unused]] const target_ptr &target) {
#ifdef SUNSHINE_BUILD_X11
    if (!target || !target->alive()) {
      return false;
    }
    const auto window = std::dynamic_pointer_cast<linux_renderer_t>(target->renderer());
    return window && target->contains(window->process_id()) && window->focused() && target->alive();
#else
    return false;
#endif
  }
}  // namespace capture
