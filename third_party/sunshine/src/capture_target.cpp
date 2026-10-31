/**
 * @file src/capture_target.cpp
 * @brief OS-backed identities for application-scoped capture.
 */
#include "capture_input.h"
#include "capture_target.h"

#ifdef _WIN32
  #include <dwmapi.h>
  #include <mutex>
  #include <vector>
  #include <windows.h>

namespace capture {
  bool input_focused(const target_ptr &target) {
    if (!input_origin(target)) {
      return false;
    }
    const auto renderer = target->renderer();
    const auto foreground = GetForegroundWindow();
    return renderer && foreground && renderer->alive() && target->alive() &&
           target->contains(renderer->process_id()) &&
           reinterpret_cast<HWND>(renderer->window_handle()) == GetAncestor(foreground, GA_ROOT);
  }

  std::optional<std::pair<int, int>> input_origin(const target_ptr &target, const input_viewport_t *viewport) {
    if (!target || !target->alive()) {
      return std::nullopt;
    }
    const auto renderer = target->renderer();
    if (!renderer || !renderer->alive() || !target->contains(renderer->process_id())) {
      return std::nullopt;
    }
    if (viewport && (viewport->renderer != renderer || viewport->width <= 0 || viewport->height <= 0)) {
      return std::nullopt;
    }
    const auto window = reinterpret_cast<HWND>(renderer->window_handle());
    if (!IsWindowVisible(window) || IsIconic(window)) {
      return std::nullopt;
    }
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) {
      return std::nullopt;
    }
    RECT bounds {};
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds))) && !GetWindowRect(window, &bounds)) {
      return std::nullopt;
    }
    if (!target->alive() || !renderer->alive() || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
      return std::nullopt;
    }
    if (viewport && (viewport->width != bounds.right - bounds.left || viewport->height != bounds.bottom - bounds.top)) {
      return std::nullopt;
    }
    return std::pair {bounds.left - GetSystemMetrics(SM_XVIRTUALSCREEN), bounds.top - GetSystemMetrics(SM_YVIRTUALSCREEN)};
  }

  namespace {
    /** @brief Window identity backed by a retained rendering-process handle. */
    class windows_renderer_t final: public renderer_t {
    public:
      /** @brief Adopt a verified window and process. @param window Window handle. @param process Owned process handle. */
      windows_renderer_t(HWND window, HANDLE process):
          window_(window),
          process_(process),
          pid_(GetProcessId(process)) {}

      /** @brief Release the rendering-process identity. */
      ~windows_renderer_t() override {
        CloseHandle(process_);
      }

      std::uint32_t process_id() const override {
        return pid_;
      }

      std::uintptr_t window_handle() const override {
        return reinterpret_cast<std::uintptr_t>(window_);
      }

      bool alive() const override {
        DWORD pid = 0;
        return WaitForSingleObject(process_, 0) == WAIT_TIMEOUT && GetWindowThreadProcessId(window_, &pid) != 0 && pid == pid_;
      }

    private:
      HWND window_;  ///< Window associated with this retained renderer.
      HANDLE process_;  ///< Holds PID identity across asynchronous media operations.
      DWORD pid_;  ///< Original rendering-process PID.
    };

    /** @brief Windows launch identity owning duplicated process and job handles. */
    class windows_target_t final: public target_t {
    public:
      /**
       * @brief Adopt validated duplicate handles.
       * @param pid Original process identifier.
       * @param process Owned process handle.
       * @param job Owned job handle.
       */
      windows_target_t(DWORD pid, HANDLE process, HANDLE job):
          pid_(pid),
          process_(process),
          job_(job) {}

      /** @brief Release retained OS identities without terminating processes. */
      ~windows_target_t() override {
        CloseHandle(job_);
        CloseHandle(process_);
      }

      std::uint32_t process_id() const override {
        return pid_;
      }

      bool alive() const override {
        if (retired()) {
          return false;
        }
        if (WaitForSingleObject(process_, 0) == WAIT_TIMEOUT) {
          return true;
        }
        {
          std::lock_guard lock(renderer_mutex_);
          if (renderer_ && renderer_->alive()) {
            return !retired();
          }
        }
        return has_live_descendant() && !retired();
      }

      bool contains(std::uint32_t pid) const override {
        if (retired() || !pid) {
          return false;
        }
        // Keep the root handle alive even after root exit: process-tree loopback
        // must never bind to another process that happens to reuse its PID.
        HANDLE process = pid == pid_ ? process_ : OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
        if (!process) {
          return false;
        }
        BOOL member = FALSE;
        const bool result = WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
                            IsProcessInJob(process, job_, &member) && member;
        if (process != process_) {
          CloseHandle(process);
        }
        return result && !retired();
      }

      renderer_ptr renderer() const override {
        std::lock_guard lock(renderer_mutex_);
        if (retired()) {
          return nullptr;
        }
        if (renderer_ && renderer_->alive()) {
          return renderer_;
        }

        struct selection_t {
          const windows_target_t &target;  ///< Launch whose windows are eligible.
          HWND window {nullptr};  ///< Largest eligible window.
          std::int64_t area {0};  ///< Visible client area used for initial selection.
        } selection {*this};

        EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
          auto &selection = *reinterpret_cast<selection_t *>(parameter);
          if (!IsWindowVisible(window) || IsIconic(window) || (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)) {
            return TRUE;
          }
          DWORD pid = 0;
          GetWindowThreadProcessId(window, &pid);
          if (!selection.target.contains(pid)) {
            return TRUE;
          }
          DWORD cloaked = 0;
          if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) {
            return TRUE;
          }
          RECT rect {};
          if (GetClientRect(window, &rect)) {
            const auto area = static_cast<std::int64_t>(rect.right - rect.left) * (rect.bottom - rect.top);
            if (area > selection.area) {
              selection.window = window;
              selection.area = area;
            }
          }
          return TRUE;
        },
                    reinterpret_cast<LPARAM>(&selection));
        if (!selection.window) {
          return nullptr;
        }
        DWORD pid = 0;
        GetWindowThreadProcessId(selection.window, &pid);
        std::unique_ptr<void, decltype(&CloseHandle)> process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid), &CloseHandle);
        BOOL member = FALSE;
        if (!process || !IsProcessInJob(process.get(), job_, &member) || !member || retired()) {
          return nullptr;
        }
        auto candidate = std::make_shared<windows_renderer_t>(selection.window, process.get());
        process.release();
        if (!candidate->alive()) {
          return nullptr;
        }
        renderer_ = std::move(candidate);
        return renderer_;
      }

    private:
      /**
       * @brief Verify live job members after a bootstrap root has exited.
       * @return True if at least one retained job member is still running.
       * @note Job accounting can lag process termination; never authorize from its count alone.
       */
      bool has_live_descendant() const {
        for (std::size_t capacity = 16; capacity <= 65536; capacity *= 2) {
          std::vector<std::uintptr_t> storage(capacity + 2);
          auto *list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST *>(storage.data());
          if (!QueryInformationJobObject(job_, JobObjectBasicProcessIdList, list, static_cast<DWORD>(storage.size() * sizeof(std::uintptr_t)), nullptr)) {
            if (GetLastError() == ERROR_MORE_DATA) {
              continue;
            }
            return false;
          }
          if (list->NumberOfProcessIdsInList > capacity) {
            continue;
          }
          for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index) {
            const auto pid = static_cast<DWORD>(list->ProcessIdList[index]);
            if (pid != pid_ && contains(pid)) {
              return true;
            }
          }
          return false;
        }
        return false;
      }

      DWORD pid_;  ///< Stable root PID protected from reuse by process_.
      HANDLE process_;  ///< Retained root process identity.
      HANDLE job_;  ///< Retained job membership for descendant windows.
      mutable std::mutex renderer_mutex_;  ///< Serializes shared video/audio renderer selection.
      mutable renderer_ptr renderer_;  ///< Stable renderer until its window or process exits.
    };
  }  // namespace

  target_ptr bind_application(std::uint32_t pid, std::uintptr_t process_handle, std::uintptr_t group_handle) {
    const auto process = reinterpret_cast<HANDLE>(process_handle);
    const auto job = reinterpret_cast<HANDLE>(group_handle);
    if (!pid || !process || !job || GetProcessId(process) != pid) {
      return nullptr;
    }
    BOOL member = FALSE;
    if (!IsProcessInJob(process, job, &member) || !member) {
      return nullptr;
    }
    HANDLE retained_process = nullptr;
    HANDLE retained_job = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), process, GetCurrentProcess(), &retained_process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, 0)) {
      return nullptr;
    }
    if (!DuplicateHandle(GetCurrentProcess(), job, GetCurrentProcess(), &retained_job, JOB_OBJECT_QUERY, FALSE, 0)) {
      CloseHandle(retained_process);
      return nullptr;
    }
    target_ptr target;
    try {
      target = std::make_shared<windows_target_t>(pid, retained_process, retained_job);
    } catch (...) {
      CloseHandle(retained_process);
      CloseHandle(retained_job);
      throw;
    }
    // Launchers may exit before their process creation call returns. The job
    // and retained root object still identify the same live renderer tree.
    return target->alive() ? target : nullptr;
  }
}  // namespace capture
#else
namespace capture {
  bool input_focused(const target_ptr &) {
    return false;
  }

  std::optional<std::pair<int, int>> input_origin(const target_ptr &, const input_viewport_t *) {
    return std::nullopt;
  }

  #if !defined(__linux__)
  target_ptr bind_application(std::uint32_t, std::uintptr_t, std::uintptr_t) {
    // An unsupported backend must reject application scope, never capture desktop.
    return nullptr;
  }
  #endif
}  // namespace capture
#endif
