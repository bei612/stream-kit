/**
 * @file tests/unit/test_capture_target.cpp
 * @brief Verify retained application identity without capturing the host or sending input.
 */
#include "src/capture_target.h"

#include <gtest/gtest.h>

#ifdef _WIN32
  #include "src/platform/windows/process_loopback.h"

  #include <array>
  #include <chrono>
  #include <string>
  #include <thread>
  #include <windows.h>

namespace {
  /** @brief Foreign renderer used to verify the launch-membership boundary. */
  class foreign_renderer_t final: public capture::renderer_t {
  public:
    std::uint32_t process_id() const override {
      return GetCurrentProcessId();
    }

    std::uintptr_t window_handle() const override {
      return 0;
    }

    bool alive() const override {
      return true;
    }
  };

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

  TEST_F(CaptureTargetTest, RendererSelectionCannotUseUnrelatedWindows) {
    auto target = bind();
    ASSERT_NE(target, nullptr);
    EXPECT_EQ(target->renderer(), nullptr);
    target->retire();
    EXPECT_EQ(target->renderer(), nullptr);
  }

  TEST_F(CaptureTargetTest, OwnershipTransferRetiresOnlyTheReplacedLaunch) {
    auto first = bind();
    auto second = bind();
    ASSERT_NE(first, nullptr);
    ASSERT_NE(second, nullptr);
    {
      capture::target_owner_t owner;
      owner.replace(first);
      capture::target_owner_t transferred(std::move(owner));
      EXPECT_EQ(owner.get(), nullptr);
      EXPECT_TRUE(first->alive());
      owner.replace(second);
      owner = std::move(transferred);
      EXPECT_FALSE(second->alive());
      EXPECT_TRUE(first->alive());
      EXPECT_EQ(owner.get(), first);
      owner.replace(first);
      EXPECT_TRUE(first->alive());
    }
    EXPECT_FALSE(first->alive());
    EXPECT_EQ(WaitForSingleObject(child_.hProcess, 0), static_cast<DWORD>(WAIT_TIMEOUT));
  }

  TEST_F(CaptureTargetTest, RejectsMismatchedProcessAndUnrelatedJob) {
    EXPECT_EQ(capture::bind_application(GetCurrentProcessId(), reinterpret_cast<std::uintptr_t>(child_.hProcess), reinterpret_cast<std::uintptr_t>(job_)), nullptr);
    HANDLE unrelated_job = CreateJobObjectW(nullptr, nullptr);
    ASSERT_NE(unrelated_job, nullptr);
    EXPECT_EQ(capture::bind_application(child_.dwProcessId, reinterpret_cast<std::uintptr_t>(child_.hProcess), reinterpret_cast<std::uintptr_t>(unrelated_job)), nullptr);
    CloseHandle(unrelated_job);
    EXPECT_EQ(capture::bind_application(0, 0, 0), nullptr);
  }

  TEST_F(CaptureTargetTest, ExitedRootIsNeverCapturedAndEmptyJobCannotBind) {
    auto target = bind();
    ASSERT_NE(target, nullptr);
    ASSERT_NE(ResumeThread(child_.hThread), static_cast<DWORD>(-1));
    ASSERT_EQ(WaitForSingleObject(child_.hProcess, 5000), static_cast<DWORD>(WAIT_OBJECT_0));
    EXPECT_FALSE(target->contains(child_.dwProcessId));
    // cmd may leave its console host alive briefly. Root exit alone is not job
    // exit: real bootstrap launches also leave a renderer in this same job.
    ASSERT_TRUE(TerminateJobObject(job_, 0));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (target->alive() && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    ASSERT_FALSE(target->alive());
    EXPECT_EQ(bind(), nullptr);
  }

  TEST_F(CaptureTargetTest, ProcessAudioRejectsMissingOrRetiredIdentity) {
    IAudioClient *client = nullptr;
    EXPECT_EQ(platf::audio::activate_process_loopback({}, &client), E_INVALIDARG);
    EXPECT_EQ(client, nullptr);
    auto target = bind();
    ASSERT_NE(target, nullptr);
    EXPECT_EQ(platf::audio::activate_process_loopback(target, nullptr), E_POINTER);
    target->retire();
    EXPECT_EQ(platf::audio::activate_process_loopback(target, &client), E_INVALIDARG);
    EXPECT_EQ(client, nullptr);
  }

  TEST_F(CaptureTargetTest, ProcessAudioRejectsRendererOutsideTheLaunchJob) {
    auto target = bind();
    ASSERT_NE(target, nullptr);
    IAudioClient *client = nullptr;
    EXPECT_EQ(platf::audio::activate_process_loopback(target, &client, std::make_shared<foreign_renderer_t>()), E_INVALIDARG);
    EXPECT_EQ(client, nullptr);
  }

  TEST_F(CaptureTargetTest, ActivatesProcessAudioWithoutChangingHostEndpoint) {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ASSERT_TRUE(SUCCEEDED(initialized));

    struct com_guard_t {
      ~com_guard_t() {
        CoUninitialize();
      }
    } com_guard;

    auto target = bind();
    ASSERT_NE(target, nullptr);
    IAudioClient *raw_client = nullptr;
    ASSERT_EQ(platf::audio::activate_process_loopback(target, &raw_client), S_OK);
    ASSERT_NE(raw_client, nullptr);
    const auto release_client = [](IAudioClient *client) {
      client->Release();
    };
    std::unique_ptr<IAudioClient, decltype(release_client)> client(raw_client, release_client);
    WAVEFORMATEX format {};
    format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32;
    format.nBlockAlign = 8;
    format.nAvgBytesPerSec = 384000;
    ASSERT_EQ(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0, 0, &format, nullptr), S_OK);
    UINT32 frames = 0;
    EXPECT_EQ(client->GetBufferSize(&frames), S_OK);
    EXPECT_GT(frames, 0U);
    EXPECT_EQ(client->Start(), S_OK);
    EXPECT_EQ(client->Stop(), S_OK);
  }
}  // namespace
#endif
