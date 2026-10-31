/**
 * @file src/platform/linux/application_target.cpp
 * @brief Retained Linux launch identities shared by application audio and video.
 */
#include "src/capture_target.h"

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
        // Window selection is supplied by the Linux window-capture backend.
        // Until that backend is connected, never substitute the desktop.
        return nullptr;
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
}  // namespace capture
