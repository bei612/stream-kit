/**
 * @file tests/unit/test_linux_capture_target.cpp
 * @brief Linux launch ownership tested against real isolated process groups.
 */
#if defined(__linux__)
#include "src/capture_target.h"

#include <cerrno>
#include <gtest/gtest.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace {
  /** @brief Creates only test-owned children; never signals a shared process group. */
  class LinuxCaptureTargetTest: public ::testing::Test {
  protected:
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
}  // namespace
#endif
