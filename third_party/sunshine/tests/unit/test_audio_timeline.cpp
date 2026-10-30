/** @file tests/unit/test_audio_timeline.cpp
 * @brief Timestamp discontinuity and bounded gap accounting tests.
 */
#include "src/audio_timeline.h"
#include <gtest/gtest.h>

TEST(CaptureTimelineTest, PreservesStartupGapAndDoesNotRepeatIt) {
  audio::capture_timeline_t clock(48000);
  EXPECT_EQ(clock.accept(10000000, 480, true), 0);
  EXPECT_EQ(clock.accept(16700000, 480, true), 31680);
  EXPECT_EQ(clock.accept(16800000, 480, true), 0);
}

TEST(CaptureTimelineTest, DoesNotInventFramesFromJitterOrInvalidTimestamps) {
  audio::capture_timeline_t clock(48000);
  EXPECT_EQ(clock.accept(10000000, 480, true), 0);
  EXPECT_EQ(clock.accept(10105000, 480, true), 0);
  EXPECT_EQ(clock.accept(10200000, 480, true), 0);
  EXPECT_EQ(clock.accept(18000000, 480, false), 0);
  EXPECT_EQ(clock.accept(19000000, 480, true), 0);
}

TEST(CaptureTimelineTest, RejectsUnboundedGapsAndBackwardClock) {
  audio::capture_timeline_t clock(48000);
  ASSERT_EQ(clock.accept(10000000, 480, true), 0);
  EXPECT_FALSE(clock.accept(50000000, 480, true));
  ASSERT_EQ(clock.accept(60000000, 480, true), 0);
  EXPECT_FALSE(clock.accept(59000000, 480, true));
}

TEST(CaptureTimelineTest, BoundsGapAtTwoSecondsAndResetsAfterInvalidClock) {
  audio::capture_timeline_t clock(48000);
  ASSERT_EQ(clock.accept(10000000, 480, true), 0);
  EXPECT_EQ(clock.accept(30100000, 480, true), 96000);
  EXPECT_FALSE(clock.accept(50210000, 480, true));
  EXPECT_EQ(clock.accept(50310000, 480, true), 0);
  EXPECT_EQ(clock.accept(0, 480, true), 0);
  EXPECT_EQ(clock.accept(90000000, 480, true), 0);
}
