/**
 * @file src/capture_target.cpp
 * @brief OS-backed identities for application-scoped capture.
 */
#include "capture_target.h"

#ifdef _WIN32
  #include <windows.h>

namespace capture {
  namespace {
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
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting {};
        return QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) &&
               accounting.ActiveProcesses > 0;
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

    private:
      DWORD pid_;  ///< Stable root PID protected from reuse by process_.
      HANDLE process_;  ///< Retained root process identity.
      HANDLE job_;  ///< Retained job membership for descendant windows.
    };
  }  // namespace

  target_ptr bind_application(std::uint32_t pid, std::uintptr_t process_handle, std::uintptr_t group_handle) {
    const auto process = reinterpret_cast<HANDLE>(process_handle);
    const auto job = reinterpret_cast<HANDLE>(group_handle);
    if (!pid || !process || !job || GetProcessId(process) != pid || WaitForSingleObject(process, 0) != WAIT_TIMEOUT) {
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
    return std::make_shared<windows_target_t>(pid, retained_process, retained_job);
  }
}  // namespace capture
#else
namespace capture {
  target_ptr bind_application(std::uint32_t, std::uintptr_t, std::uintptr_t) {
    // An unsupported backend must reject application scope, never capture desktop.
    return nullptr;
  }
}  // namespace capture
#endif
