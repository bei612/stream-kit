/**
 * @file tests/unit/test_capture_target.cpp
 * @brief Verify retained application identity without capturing the host or sending input.
 */
#include "src/capture_target.h"

#include <gtest/gtest.h>

#ifdef _WIN32
  #include <array>
  #include <string>
  #include <windows.h>

namespace {
  /** @brief Own a test-only job and suspended child; never alter the test host's job. */
  class CaptureTargetTest: public ::testing::Test {
  protected:
    /** @brief Start a hidden, suspended command that only exits when resumed. */
    void SetUp() override {
      job_ = CreateJobObjectW(nullptr, nullptr);
      ASSERT_NE(job_, nullptr);
      std::array<wchar_t, MAX_PATH> system_directory {};
      ASSERT_GT(GetSystemDirectoryW(system_directory.data(), system_directory.size()), 0U);
      const std::wstring exe = std::wstring(system_directory.data()) + L"\\cmd.exe";
      std::wstring command = L"\"" + exe + L"\" /d /c exit /b 0";
      STARTUPINFOW startup {};
      startup.cb = sizeof(startup);
      ASSERT_TRUE(CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child_));
      ASSERT_TRUE(AssignProcessToJobObject(job_, child_.hProcess));
    }

    /** @brief Release only the child and job created by this test. */
    void TearDown() override {
      if (child_.hProcess) {
        if (WaitForSingleObject(child_.hProcess, 0) == WAIT_TIMEOUT) {
          TerminateProcess(child_.hProcess, 0);
          WaitForSingleObject(child_.hProcess, 5000);
        }
        CloseHandle(child_.hProcess);
      }
      if (child_.hThread) {
        CloseHandle(child_.hThread);
      }
      if (job_) {
        CloseHandle(job_);
      }
    }

    /**
     * @brief Bind a target to this fixture's owned process and job.
     * @return Retained capture identity for the fixture.
     */
    capture::target_ptr bind() const {
      return capture::bind_application(child_.dwProcessId, reinterpret_cast<std::uintptr_t>(child_.hProcess), reinterpret_cast<std::uintptr_t>(job_));
    }

    HANDLE job_ {nullptr};  ///< Fixture-owned job.
    PROCESS_INFORMATION child_ {};  ///< Fixture-owned hidden child.
  };

  TEST_F(CaptureTargetTest, RetainsIdentityAndRejectsUnrelatedProcesses) {
    auto target = bind();
    ASSERT_NE(target, nullptr);
    EXPECT_EQ(target->process_id(), child_.dwProcessId);
    EXPECT_TRUE(target->alive());
    EXPECT_TRUE(target->contains(child_.dwProcessId));
    EXPECT_FALSE(target->contains(GetCurrentProcessId()));
    EXPECT_FALSE(target->contains(0));
    // The factory duplicates handles rather than borrowing their lifetime.
    CloseHandle(job_);
    job_ = nullptr;
    EXPECT_TRUE(target->alive());
    EXPECT_TRUE(target->contains(child_.dwProcessId));
  }

  TEST_F(CaptureTargetTest, RetirementIsPermanentWhileProcessRemainsAlive) {
    auto target = bind();
    ASSERT_NE(target, nullptr);
    target->retire();
    target->retire();
    EXPECT_FALSE(target->alive());
    EXPECT_FALSE(target->contains(child_.dwProcessId));
    EXPECT_EQ(WaitForSingleObject(child_.hProcess, 0), static_cast<DWORD>(WAIT_TIMEOUT));
    EXPECT_EQ(target->process_id(), child_.dwProcessId);
  }

  TEST_F(CaptureTargetTest, RejectsMismatchedProcessAndUnrelatedJob) {
    EXPECT_EQ(capture::bind_application(GetCurrentProcessId(), reinterpret_cast<std::uintptr_t>(child_.hProcess), reinterpret_cast<std::uintptr_t>(job_)), nullptr);
    HANDLE unrelated_job = CreateJobObjectW(nullptr, nullptr);
    ASSERT_NE(unrelated_job, nullptr);
    EXPECT_EQ(capture::bind_application(child_.dwProcessId, reinterpret_cast<std::uintptr_t>(child_.hProcess), reinterpret_cast<std::uintptr_t>(unrelated_job)), nullptr);
    CloseHandle(unrelated_job);
    EXPECT_EQ(capture::bind_application(0, 0, 0), nullptr);
  }

  TEST_F(CaptureTargetTest, ExitedProcessNeverAuthorizesCapture) {
    auto target = bind();
    ASSERT_NE(target, nullptr);
    ASSERT_NE(ResumeThread(child_.hThread), static_cast<DWORD>(-1));
    ASSERT_EQ(WaitForSingleObject(child_.hProcess, 5000), static_cast<DWORD>(WAIT_OBJECT_0));
    EXPECT_FALSE(target->contains(child_.dwProcessId));
    EXPECT_EQ(bind(), nullptr);
  }
}  // namespace
#endif
