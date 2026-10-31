/**
 * @file tests/unit/test_linux_capture_target.cpp
 * @brief Linux launch ownership tested against real isolated process groups.
 */
#if defined(__linux__)
#include "src/capture_input.h"

#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <gtest/gtest.h>
#include <signal.h>
#include <spawn.h>
#include <string>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

#ifdef SUNSHINE_BUILD_X11
  #include <xcb/xcb.h>
#endif

extern char **environ;  ///< Test environment containing the isolated DISPLAY.

namespace {
  /** @brief Creates only test-owned children; never signals a shared process group. */
  class LinuxCaptureTargetTest: public ::testing::Test {
  protected:
#ifdef SUNSHINE_BUILD_X11
    /** @brief Start an isolated application with a real X11 window. @param geometry Window dimensions. @return Owned PID, or -1. */
    pid_t spawn_window(const std::string &geometry) {
      std::vector<std::string> arguments {"xmessage", "-title", "StreamKitCaptureOwner", "-geometry", geometry, "-timeout", "30", "Owned capture window"};
      std::vector<char *> argv;
      for (auto &argument : arguments) {
        argv.push_back(argument.data());
      }
      argv.push_back(nullptr);
      posix_spawnattr_t attributes;
      if (posix_spawnattr_init(&attributes) != 0) {
        return -1;
      }
      const auto group = posix_spawnattr_setpgroup(&attributes, 0);
      const auto flags = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
      pid_t child = -1;
      const auto result = group == 0 && flags == 0 ? posix_spawnp(&child, "xmessage", nullptr, &attributes, argv.data(), environ) : EINVAL;
      posix_spawnattr_destroy(&attributes);
      if (result != 0) {
        return -1;
      }
      children_.push_back(child);
      return child;
    }
#endif

    /** @brief Start a stopped-in-place child in an explicit group. @param group Zero for a new group. @return Child PID or -1. */
    pid_t spawn(pid_t group = 0) {
      int ready[2];
      if (pipe(ready) < 0) {
        return -1;
      }
      const auto child = fork();
      if (child == 0) {
        close(ready[0]);
        // Only async-signal-safe operations are used after fork; no C++ allocation,
        // PulseAudio context, or inherited logging worker is touched here.
        const bool grouped = setpgid(0, group) == 0;
        const char result = grouped ? '1' : '0';
        if (write(ready[1], &result, 1) != 1 || !grouped) {
          _exit(1);
        }
        close(ready[1]);
        while (true) {
          pause();
        }
      }
      close(ready[1]);
      if (child < 0) {
        close(ready[0]);
        return -1;
      }
      children_.push_back(child);
      char result = '0';
      ssize_t count;
      do {
        count = read(ready[0], &result, 1);
      } while (count < 0 && errno == EINTR);
      close(ready[0]);
      return count == 1 && result == '1' ? child : -1;
    }

    /** @brief Stop and reap a retained direct child. @param pid Test-owned PID, replaced with zero after reaping. */
    static void stop(pid_t &pid) {
      if (pid <= 0) {
        return;
      }
      // Direct children cannot have their numeric PID recycled before we reap them.
      kill(pid, SIGTERM);
      while (waitpid(pid, nullptr, 0) < 0 && errno == EINTR) {}
      pid = 0;
    }

    /** @brief Stop the requested fixture child once. @param pid Test-owned child. */
    void stop_child(pid_t pid) {
      for (auto &child : children_) {
        if (child == pid) {
          stop(child);
          return;
        }
      }
      FAIL() << "Attempted to stop a process not owned by this fixture";
    }

    void TearDown() override {
      for (auto &child : children_) {
        stop(child);
      }
    }

    std::vector<pid_t> children_;  ///< Unreaped children created by this fixture only.
  };

  TEST_F(LinuxCaptureTargetTest, BindsOnlyTheIsolatedLaunchAndRejectsUnrelatedProcesses) {
    const auto root = spawn();
    const auto other = spawn();
    ASSERT_GT(root, 1);
    ASSERT_GT(other, 1);
    auto target = capture::bind_application(root, root, root);
    ASSERT_NE(target, nullptr);
    EXPECT_TRUE(target->alive());
    EXPECT_EQ(target->process_id(), static_cast<std::uint32_t>(root));
    EXPECT_TRUE(target->contains(root));
    EXPECT_FALSE(target->contains(other));
    EXPECT_FALSE(target->contains(getpid()));
    EXPECT_EQ(capture::bind_application(root, other, root), nullptr);
    EXPECT_EQ(capture::bind_application(root, root, other), nullptr);
    EXPECT_EQ(capture::bind_application(0, 0, 0), nullptr);
    EXPECT_EQ(capture::bind_application(getpid(), getpid(), getpgrp()), nullptr);
  }

  TEST_F(LinuxCaptureTargetTest, RetainsKnownMembersAfterLauncherExitAndRejectsRetiredTargets) {
    const auto root = spawn();
    ASSERT_GT(root, 1);
    const auto child = spawn(root);
    ASSERT_GT(child, 1);
    auto target = capture::bind_application(root, root, root);
    ASSERT_NE(target, nullptr);
    ASSERT_TRUE(target->contains(child));
    stop_child(root);
    EXPECT_FALSE(target->contains(root));
    EXPECT_TRUE(target->alive());
    EXPECT_TRUE(target->contains(child));
    target->retire();
    EXPECT_FALSE(target->alive());
    EXPECT_FALSE(target->contains(child));
    EXPECT_EQ(kill(child, 0), 0) << "Capture retirement must not terminate the rendering program";
  }

  TEST_F(LinuxCaptureTargetTest, RejectsProcessesThatLeaveTheLaunchGroup) {
    const auto root = spawn();
    ASSERT_GT(root, 1);
    const auto child = spawn(root);
    ASSERT_GT(child, 1);
    auto target = capture::bind_application(root, root, root);
    ASSERT_NE(target, nullptr);
    ASSERT_TRUE(target->contains(child));
    ASSERT_EQ(setpgid(child, child), 0);
    EXPECT_FALSE(target->contains(child));
    EXPECT_TRUE(target->contains(root));
  }

  TEST_F(LinuxCaptureTargetTest, DoesNotReopenDeadIdentitiesByNumericPid) {
    const auto root = spawn();
    ASSERT_GT(root, 1);
    auto target = capture::bind_application(root, root, root);
    ASSERT_NE(target, nullptr);
    stop_child(root);
    EXPECT_FALSE(target->alive());
    EXPECT_FALSE(target->contains(root));
    const auto replacement = spawn();
    ASSERT_GT(replacement, 1);
    EXPECT_FALSE(target->contains(replacement));
    EXPECT_FALSE(target->alive());
  }

#ifdef SUNSHINE_BUILD_X11
  TEST_F(LinuxCaptureTargetTest, SelectsOnlyTheOwnedX11WindowAndInvalidatesItAfterExit) {
    const auto enabled = std::getenv("STREAM_KIT_TEST_X11_CAPTURE");
    if (!enabled || std::string(enabled) != "1") {
      GTEST_SKIP() << "Requires an explicit isolated X11 test server";
    }
    const auto root = spawn_window("240x100+10+10");
    const auto other = spawn_window("640x480+300+10");
    ASSERT_GT(root, 1);
    ASSERT_GT(other, 1);
    auto target = capture::bind_application(root, root, root);
    auto foreign = capture::bind_application(other, other, other);
    ASSERT_NE(target, nullptr);
    ASSERT_NE(foreign, nullptr);
    capture::renderer_ptr selected;
    capture::renderer_ptr unrelated;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while ((!selected || !unrelated) && std::chrono::steady_clock::now() < deadline) {
      selected = target->renderer();
      unrelated = foreign->renderer();
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    ASSERT_NE(selected, nullptr);
    ASSERT_NE(unrelated, nullptr);
    EXPECT_EQ(selected->process_id(), static_cast<std::uint32_t>(root));
    EXPECT_NE(selected->window_handle(), unrelated->window_handle());
    EXPECT_TRUE(selected->alive());
    EXPECT_EQ(target->renderer(), selected);
    capture::input_viewport_t viewport {selected, 240, 100};
    EXPECT_TRUE(capture::input_origin(target, &viewport).has_value());
    ++viewport.width;
    EXPECT_FALSE(capture::input_origin(target, &viewport).has_value());
    viewport = {unrelated, 640, 480};
    EXPECT_FALSE(capture::input_origin(target, &viewport).has_value());
    const auto disconnect = [](xcb_connection_t *connection) { xcb_disconnect(connection); };
    std::unique_ptr<xcb_connection_t, decltype(disconnect)> connection(xcb_connect(nullptr, nullptr), disconnect);
    ASSERT_EQ(xcb_connection_has_error(connection.get()), 0);
    const auto set_focus = [&](std::uintptr_t window) {
      auto error = xcb_request_check(connection.get(), xcb_set_input_focus_checked(
        connection.get(), XCB_INPUT_FOCUS_POINTER_ROOT, static_cast<xcb_window_t>(window), XCB_CURRENT_TIME
      ));
      const bool success = error == nullptr;
      std::free(error);
      return success;
    };
    ASSERT_TRUE(set_focus(selected->window_handle()));
    EXPECT_TRUE(capture::input_focused(target));
    EXPECT_FALSE(capture::input_focused(foreign));
    ASSERT_TRUE(set_focus(unrelated->window_handle()));
    EXPECT_FALSE(capture::input_focused(target));
    EXPECT_TRUE(capture::input_focused(foreign));
    target->retire();
    EXPECT_EQ(target->renderer(), nullptr);
    EXPECT_FALSE(capture::input_origin(target).has_value());
    EXPECT_FALSE(capture::input_focused(target));
    EXPECT_TRUE(foreign->alive());
    stop_child(root);
    EXPECT_FALSE(selected->alive());
    EXPECT_TRUE(unrelated->alive());
  }
#endif
}  // namespace
#endif
