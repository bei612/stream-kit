/**
 * @file tests/unit/test_capture_config.cpp
 * @brief Capture-scope persistence and strict parser coverage without launching applications.
 */
#include "src/process.h"

#include <fstream>
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

namespace {
  /** @brief Own an isolated application configuration fixture. */
  class CaptureConfigTest: public ::testing::Test {
  protected:
    /** @brief Remove only the fixture file created by the test. */
    void TearDown() override {
      std::error_code ignored;
      std::filesystem::remove(path_, ignored);
    }

    /**
     * @brief Parse an app through the production Sunshine configuration parser.
     * @param app JSON application record.
     * @return Parsed process manager; no command is executed.
     */
    std::optional<proc::proc_t> parse(nlohmann::json app) {
      std::ofstream file(path_);
      file << nlohmann::json {{"env", nlohmann::json::object()}, {"apps", nlohmann::json::array({app})}}.dump();
      file.close();
      return proc::parse(path_.string());
    }

    std::filesystem::path path_ {std::filesystem::path(SUNSHINE_TEST_BIN_DIR) / "capture-scope-test.json"};  ///< Owned test fixture file.
  };

  TEST_F(CaptureConfigTest, LegacyApplicationsRetainExplicitDesktopSemantics) {
    auto parsed = parse({{"name", "legacy"}});
    ASSERT_TRUE(parsed);
    ASSERT_EQ(parsed->get_apps().size(), 1U);
    EXPECT_FALSE(parsed->get_apps().front().application_capture);
    EXPECT_FALSE(parsed->uses_application_capture(std::stoi(parsed->get_apps().front().id)));
    EXPECT_EQ(parsed->capture_target(), nullptr);
  }

  TEST_F(CaptureConfigTest, PersistsApplicationScopeBeforeProcessLaunch) {
    auto parsed = parse({{"name", "scoped"}, {"cmd", "never-executed"}, {"capture-mode", "application"}, {"auto-detach", false}, {"wait-all", true}});
    ASSERT_TRUE(parsed);
    ASSERT_EQ(parsed->get_apps().size(), 1U);
    EXPECT_TRUE(parsed->get_apps().front().application_capture);
    EXPECT_TRUE(parsed->uses_application_capture(std::stoi(parsed->get_apps().front().id)));
    EXPECT_FALSE(parsed->uses_application_capture(0));
    EXPECT_EQ(parsed->capture_target(), nullptr);
  }

  TEST_F(CaptureConfigTest, RejectsUnknownScopeInsteadOfFallingBackToDesktop) {
    for (const auto mode : {"", "window", "Application", "application "}) {
      EXPECT_FALSE(parse({{"name", "invalid"}, {"capture-mode", mode}})) << mode;
    }
  }
}  // namespace
