/**
 * @file tests/integration/test_application_capture.cpp
 * @brief Opt-in native application capture acceptance using a test-owned example process.
 */
#ifdef _WIN32
  #include "src/platform/windows/display.h"
  #include "src/capture_input.h"

  #include <array>
  #include <cmath>
  #include <cstdlib>
  #include <filesystem>
  #include <fstream>
  #include <gtest/gtest.h>

namespace platf::audio::tests {
  std::array<std::uint64_t, 16> capture_observations(const mic_t &mic);
}

namespace {
  /** @brief Own the example process and COM apartment for explicit integration acceptance. */
  class ApplicationCaptureIntegrationTest: public ::testing::Test {
  protected:
    /** @brief Launch only the explicitly specified example, without activating its window. */
    void SetUp() override {
      const auto executable = _wgetenv(L"STREAM_KIT_EXAMPLE_PATH");
      if (!executable || !*executable) {
        GTEST_SKIP() << "Set STREAM_KIT_EXAMPLE_PATH to the built checkerboard.exe";
      }
      const std::wstring path(executable);
      ASSERT_TRUE(std::filesystem::is_regular_file(path));
      const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      ASSERT_TRUE(SUCCEEDED(initialized));
      com_initialized_ = true;
      job_ = CreateJobObjectW(nullptr, nullptr);
      ASSERT_NE(job_, nullptr);
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits {};
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      ASSERT_TRUE(SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
      STARTUPINFOW startup {};
      startup.cb = sizeof(startup);
      startup.dwFlags = STARTF_USESHOWWINDOW;
      startup.wShowWindow = SW_SHOWNOACTIVATE;
      std::wstring command = L"\"" + path + L"\"";
      std::wstring launcher = path;
      const bool bootstrap = _wgetenv(L"STREAM_KIT_EXAMPLE_BOOTSTRAP") != nullptr;
      if (bootstrap) {
        std::array<wchar_t, MAX_PATH> system_directory {};
        ASSERT_GT(GetSystemDirectoryW(system_directory.data(), system_directory.size()), 0U);
        launcher = std::wstring(system_directory.data()) + L"\\cmd.exe";
        command = L"\"" + launcher + L"\" /d /c start \"\" /b \"" + path + L"\"";
      }
      const auto directory = std::filesystem::path(path).parent_path().wstring();
      ASSERT_TRUE(CreateProcessW(launcher.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | (bootstrap ? CREATE_NO_WINDOW : 0), nullptr, directory.c_str(), &startup, &child_));
      ASSERT_TRUE(AssignProcessToJobObject(job_, child_.hProcess));
      ASSERT_NE(ResumeThread(child_.hThread), static_cast<DWORD>(-1));
      if (bootstrap) {
        ASSERT_EQ(WaitForSingleObject(child_.hProcess, 5000), WAIT_OBJECT_0);
      }
      target_ = capture::bind_application(child_.dwProcessId, reinterpret_cast<std::uintptr_t>(child_.hProcess), reinterpret_cast<std::uintptr_t>(job_));
      ASSERT_NE(target_, nullptr);
      RecordProperty("bootstrap_root_exited", bootstrap ? "true" : "false");
    }

    /** @brief Close only the owned example; terminate its test job if graceful close times out. */
    void TearDown() override {
      if (target_) {
        target_->retire();
      }
      if (child_.hProcess) {
        EnumWindows([](HWND window, LPARAM job) -> BOOL {
          DWORD owner = 0;
          GetWindowThreadProcessId(window, &owner);
          const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, owner);
          if (process) {
            BOOL member = FALSE;
            if (IsProcessInJob(process, reinterpret_cast<HANDLE>(job), &member) && member) {
              PostMessageW(window, WM_CLOSE, 0, 0);
            }
            CloseHandle(process);
          }
          return TRUE;
        },
                    reinterpret_cast<LPARAM>(job_));
        if (WaitForSingleObject(child_.hProcess, 3000) == WAIT_TIMEOUT) {
          TerminateJobObject(job_, 0);
          WaitForSingleObject(child_.hProcess, 3000);
        }
        CloseHandle(child_.hProcess);
        CloseHandle(child_.hThread);
      }
      target_.reset();
      if (job_) {
        CloseHandle(job_);
      }
      if (com_initialized_) {
        CoUninitialize();
      }
    }

    /**
     * @brief Save an application-only BGR frame for visual inspection.
     * @param image Captured native frame.
     */
    void save_frame(const platf::img_t &image) {
      ASSERT_EQ(image.pixel_pitch, 4);
      BITMAPFILEHEADER file {};
      BITMAPINFOHEADER info {};
      info.biSize = sizeof(info);
      info.biWidth = image.width;
      info.biHeight = -image.height;
      info.biPlanes = 1;
      info.biBitCount = 32;
      info.biCompression = BI_RGB;
      info.biSizeImage = image.width * image.height * 4;
      file.bfType = 0x4d42;
      file.bfOffBits = sizeof(file) + sizeof(info);
      file.bfSize = file.bfOffBits + info.biSizeImage;
      std::ofstream output(std::filesystem::path(SUNSHINE_TEST_BIN_DIR) / "application-capture.bmp", std::ios::binary);
      ASSERT_TRUE(output);
      output.write(reinterpret_cast<const char *>(&file), sizeof(file));
      output.write(reinterpret_cast<const char *>(&info), sizeof(info));
      for (int y = 0; y < image.height; ++y) {
        output.write(reinterpret_cast<const char *>(image.data + y * image.row_pitch), image.width * 4);
      }
      ASSERT_TRUE(output);
    }

    capture::target_ptr target_;  ///< Retained identity for the test-owned example only.
    HANDLE job_ {nullptr};  ///< Test-only process group.
    PROCESS_INFORMATION child_ {};  ///< Test-owned renderer process.
    bool com_initialized_ {false};  ///< Whether this fixture must release COM.
  };

  TEST_F(ApplicationCaptureIntegrationTest, DISABLED_CapturesExampleWindowAndRejectsRetiredTarget) {
    video::config_t config {};
    config.width = 1280;
    config.height = 720;
    config.framerate = 30;
    config.capture_target = target_;
    auto display = platf::display(platf::mem_type_e::system, "", config);
    ASSERT_NE(display, nullptr);
    auto renderer = target_->renderer();
    ASSERT_NE(renderer, nullptr);
    EXPECT_EQ(target_->renderer(), renderer);
    EXPECT_TRUE(target_->contains(renderer->process_id()));
    if (_wgetenv(L"STREAM_KIT_EXAMPLE_BOOTSTRAP")) {
      EXPECT_NE(renderer->process_id(), target_->process_id());
    }
    // The example starts windowed. A desktop-sized frame is a scope violation.
    EXPECT_LT(display->width, GetSystemMetrics(SM_CXVIRTUALSCREEN));
    EXPECT_LT(display->height, GetSystemMetrics(SM_CYVIRTUALSCREEN));
    EXPECT_GT(display->width, 300);
    EXPECT_GT(display->height, 300);
    bool cursor = false;
    int frames = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    const auto status = display->capture([&](std::shared_ptr<platf::img_t> &&image, bool captured) {
      if (captured && image) {
        ++frames;
        EXPECT_EQ(image->width, display->width);
        EXPECT_EQ(image->height, display->height);
        if (frames == 3) {
          save_frame(*image);
        }
      }
      return frames < 3 && std::chrono::steady_clock::now() < deadline;
    },
                                         [&](std::shared_ptr<platf::img_t> &image) {
                                           image = display->alloc_img();
                                           return static_cast<bool>(image);
                                         },
                                         &cursor);
    EXPECT_EQ(status, platf::capture_e::ok);
    EXPECT_EQ(frames, 3);

    const auto origin_before = capture::input_origin(target_);
    ASSERT_TRUE(origin_before);
    EXPECT_EQ(origin_before->first, display->offset_x);
    EXPECT_EQ(origin_before->second, display->offset_y);
    const auto window = reinterpret_cast<HWND>(renderer->window_handle());
    RECT before_move {};
    ASSERT_TRUE(GetWindowRect(window, &before_move));
    ASSERT_TRUE(SetWindowPos(window, nullptr, before_move.left + 40, before_move.top + 30, 0, 0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE));
    const auto moved_origin = capture::input_origin(target_);
    ASSERT_TRUE(moved_origin);
    EXPECT_NE(moved_origin->first, origin_before->first);
    EXPECT_NE(moved_origin->second, origin_before->second);
    EXPECT_EQ(target_->renderer(), renderer);
    ShowWindow(window, SW_HIDE);
    EXPECT_FALSE(capture::input_origin(target_));
    ShowWindow(window, SW_SHOWNOACTIVATE);
    EXPECT_TRUE(capture::input_origin(target_));

    struct resize_t {
      const capture::target_t *target;  ///< Retained tree that owns the example window.
      HWND window {nullptr};  ///< Main example window to resize.
    } resize {target_.get()};

    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
      auto &resize = *reinterpret_cast<resize_t *>(parameter);
      DWORD pid = 0;
      GetWindowThreadProcessId(window, &pid);
      if (resize.target->contains(pid) && GetDlgItem(window, 201)) {
        resize.window = window;
        return FALSE;
      }
      return TRUE;
    },
                reinterpret_cast<LPARAM>(&resize));
    ASSERT_NE(resize.window, nullptr);
    const auto old_width = display->width;
    RECT old_bounds {};
    ASSERT_TRUE(GetWindowRect(resize.window, &old_bounds));
    // Query and resize in the same DPI coordinate space; the example's initial
    // window may already be larger than a fixed test size.
    ASSERT_TRUE(SetWindowPos(resize.window, nullptr, 0, 0,
                            old_bounds.right - old_bounds.left + 160,
                            old_bounds.bottom - old_bounds.top + 120,
                            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE));
    const auto resized_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    EXPECT_EQ(display->capture([&](auto &&, bool) {
      return std::chrono::steady_clock::now() < resized_deadline;
    },
                               [&](std::shared_ptr<platf::img_t> &image) {
                                 image = display->alloc_img();
                                 return static_cast<bool>(image);
                               },
                               &cursor),
              platf::capture_e::reinit);
    display.reset();
    display = platf::display(platf::mem_type_e::system, "", config);
    ASSERT_NE(display, nullptr);
    EXPECT_GT(display->width, old_width);
    target_->retire();
    EXPECT_EQ(target_->renderer(), nullptr);
    EXPECT_FALSE(capture::input_origin(target_));
    EXPECT_EQ(display->capture([](auto &&, bool) {
      return false;
    },
                               [&](std::shared_ptr<platf::img_t> &image) {
                                 image = display->alloc_img();
                                 return static_cast<bool>(image);
                               },
                               &cursor),
              platf::capture_e::error);
    EXPECT_EQ(platf::display(platf::mem_type_e::system, "", config), nullptr);
    display.reset();
  }

  TEST_F(ApplicationCaptureIntegrationTest, DISABLED_CapturesExampleChildTestTone) {
    const auto output_name = _wgetenv(L"STREAM_KIT_EXAMPLE_AUDIO_OUTPUT");
    if (!output_name || !*output_name) {
      GTEST_SKIP() << "Set STREAM_KIT_EXAMPLE_AUDIO_OUTPUT to an explicit example output device name";
    }
    const std::wstring selected_name(output_name);
    HWND example = nullptr;

    struct search_t {
      const capture::target_t *target;  ///< Fixture-owned renderer tree.
      HWND *window;  ///< Receives the example's main window.
    } search {target_.get(), &example};

    int device_index = -1;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline && device_index < 0) {
      EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
        auto &search = *reinterpret_cast<search_t *>(parameter);
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        if (search.target->contains(pid) && GetDlgItem(window, 201)) {
          *search.window = window;
          return FALSE;
        }
        return TRUE;
      },
                  reinterpret_cast<LPARAM>(&search));
      if (example) {
        HWND combo = GetDlgItem(example, 201);
        const auto count = SendMessageW(combo, CB_GETCOUNT, 0, 0);
        for (int i = 0; i < count; ++i) {
          const auto length = SendMessageW(combo, CB_GETLBTEXTLEN, i, 0);
          if (length < 0 || length > 4096) {
            continue;
          }
          std::wstring name(static_cast<std::size_t>(length) + 1, L'\0');
          SendMessageW(combo, CB_GETLBTEXT, i, reinterpret_cast<LPARAM>(name.data()));
          name.resize(length);
          if (name == selected_name) {
            device_index = i;
            break;
          }
        }
      }
      if (device_index < 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    }
    ASSERT_GE(device_index, 0) << "Explicit output device is unavailable; no fallback was selected";
    auto microphone = platf::application_microphone(target_, 2, 48000, 240, true);
    ASSERT_NE(microphone, nullptr);
    ASSERT_NE(SendMessageW(GetDlgItem(example, 201), CB_SETCURSEL, device_index, 0), CB_ERR);
    ASSERT_TRUE(PostMessageW(example, WM_COMMAND, MAKEWPARAM(213, BN_CLICKED), reinterpret_cast<LPARAM>(GetDlgItem(example, 213))));

    std::vector<float> samples;
    const auto started = std::chrono::steady_clock::now();
    const auto until = started + std::chrono::seconds(4);
    int timeouts = 0;
    double first_packet_ms = -1;
    double last_packet_ms = -1;
    double longest_sample_ms = 0;
    while (std::chrono::steady_clock::now() < until) {
      std::vector<float> packet(480);
      const auto sample_started = std::chrono::steady_clock::now();
      const auto status = microphone->sample(packet);
      longest_sample_ms = std::max(longest_sample_ms, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - sample_started).count());
      ASSERT_NE(status, platf::capture_e::error);
      ASSERT_NE(status, platf::capture_e::reinit);
      if (status == platf::capture_e::ok) {
        last_packet_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        if (first_packet_ms < 0) {
          first_packet_ms = last_packet_ms;
        }
        for (std::size_t i = 0; i < packet.size(); i += 2) {
          samples.push_back((packet[i] + packet[i + 1]) * 0.5f);
        }
      } else if (status == platf::capture_e::timeout) {
        ++timeouts;
      }
      ASSERT_LT(samples.size(), 48000U * 8U) << "Capture emitted faster than the audio clock";
    }
    target_->retire();
    std::vector<float> retired_packet(480);
    EXPECT_EQ(microphone->sample(retired_packet), platf::capture_e::error);
    const auto observed = platf::audio::tests::capture_observations(*microphone);
    const std::array<const char *, 16> names {"native_packets", "native_frames", "native_silent_frames", "native_first_position", "native_end_position", "native_first_qpc", "native_last_qpc", "native_timestamp_errors", "native_max_delta_100ns", "native_gaps_over_15ms", "native_gap_excess_100ns", "native_max_gap_start_100ns", "native_max_peek_us", "native_max_wait_us", "native_max_get_us", "native_max_release_us"};
    for (std::size_t i = 0; i < names.size(); ++i) {
      RecordProperty(names[i], std::to_string(observed[i]));
    }
    microphone.reset();
    RecordProperty("captured_frames", std::to_string(samples.size()));
    RecordProperty("first_packet_ms", std::to_string(first_packet_ms));
    RecordProperty("last_packet_ms", std::to_string(last_packet_ms));
    RecordProperty("capture_timeouts", timeouts);
    RecordProperty("longest_sample_ms", std::to_string(longest_sample_ms));
    // Four seconds must remain four seconds of PCM, including silent intervals.
    EXPECT_GT(samples.size(), 48000U * 38U / 10U);
    EXPECT_LT(samples.size(), 48000U * 42U / 10U);
    ASSERT_FALSE(samples.empty());
    double energy = 0;
    double real = 0;
    double imaginary = 0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
      const auto angle = 2.0 * 3.14159265358979323846 * 997.0 * static_cast<double>(i) / 48000.0;
      energy += samples[i] * samples[i];
      real += samples[i] * std::cos(angle);
      imaginary += samples[i] * std::sin(angle);
    }
    const auto rms = std::sqrt(energy / samples.size());
    const auto amplitude = 2.0 * std::hypot(real, imaginary) / samples.size();
    RecordProperty("rms", std::to_string(rms));
    RecordProperty("tone_997hz_amplitude", std::to_string(amplitude));
    EXPECT_GT(rms, 0.005);
    EXPECT_GT(amplitude, 0.005);
  }
}  // namespace
#endif
