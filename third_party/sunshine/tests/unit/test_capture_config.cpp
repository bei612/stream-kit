/**
 * @file tests/unit/test_capture_config.cpp
 * @brief Capture-scope persistence and strict parser coverage without launching applications.
 */
#include "src/process.h"

#include <atomic>
#include <fstream>
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <thread>

namespace {
  /** @brief Own an isolated application configuration fixture. */
  class CaptureConfigTest: public ::testing::Test {
  protected:
    /** @brief Remove only the fixture file created by the test. */
    void TearDown() override {
      manager_.terminate();
      std::error_code ignored;
      std::filesystem::remove(path_, ignored);
    }

    /**
     * @brief Parse an app through the production Sunshine configuration parser.
     * @param app JSON application record.
     * @param env Configuration environment overrides.
     * @return Parsed catalog; no command is executed.
     */
    std::optional<proc::catalog_t> parse(nlohmann::json app, nlohmann::json env = nlohmann::json::object()) {
      std::ofstream file(path_);
      file << nlohmann::json {{"env", env}, {"apps", nlohmann::json::array({app})}}.dump();
      file.close();
      return proc::parse(path_.string());
    }

    std::filesystem::path path_ {std::filesystem::path(SUNSHINE_TEST_BIN_DIR) / "capture-scope-test.json"};  ///< Owned test fixture file.
    proc::proc_t manager_;  ///< Isolated manager; tests only launch command-free desktop placeholders.
  };

  TEST_F(CaptureConfigTest, LegacyApplicationsRetainExplicitDesktopSemantics) {
    auto parsed = parse({{"name", "legacy"}});
    ASSERT_TRUE(parsed);
    ASSERT_EQ(parsed->apps.size(), 1U);
    const auto id = std::stoi(parsed->apps.front().id);
    EXPECT_FALSE(parsed->apps.front().application_capture);
    manager_.replace_catalog(std::move(*parsed));
    EXPECT_FALSE(manager_.uses_application_capture(id));
    EXPECT_EQ(manager_.capture_target(), nullptr);
    EXPECT_EQ(manager_.running(), 0);
  }

  TEST_F(CaptureConfigTest, PersistsApplicationScopeBeforeProcessLaunch) {
    auto parsed = parse({{"name", "scoped"}, {"cmd", "never-executed"}, {"capture-mode", "application"}, {"auto-detach", false}, {"wait-all", true}});
    ASSERT_TRUE(parsed);
    ASSERT_EQ(parsed->apps.size(), 1U);
    const auto id = std::stoi(parsed->apps.front().id);
    EXPECT_TRUE(parsed->apps.front().application_capture);
    manager_.replace_catalog(std::move(*parsed));
    EXPECT_TRUE(manager_.uses_application_capture(id));
    EXPECT_FALSE(manager_.uses_application_capture(0));
    EXPECT_EQ(manager_.capture_target(), nullptr);
  }

  TEST_F(CaptureConfigTest, RejectsUnknownScopeInsteadOfFallingBackToDesktop) {
    for (const auto mode : {"", "window", "Application", "application "}) {
      EXPECT_FALSE(parse({{"name", "invalid"}, {"capture-mode", mode}})) << mode;
    }
  }

  TEST_F(CaptureConfigTest, ConfigurationEnvironmentNeverMutatesHostEnvironment) {
    const std::string key = "STREAM_KIT_CATALOG_ENV_TEST";
    auto host = boost::this_process::environment();
    const auto before = host[key].to_string();
    const auto existed = host[key].empty();
    auto parsed = parse({{"name", "env"}, {"cmd", "$(STREAM_KIT_CATALOG_ENV_TEST)"}}, {{key, "catalog-only"}});
    ASSERT_TRUE(parsed);
    EXPECT_EQ(parsed->env[key].to_string(), "catalog-only");
    EXPECT_EQ(parsed->apps.front().cmd, "catalog-only");
    EXPECT_EQ(host[key].to_string(), before);
    EXPECT_EQ(host[key].empty(), existed);
    auto next = parse({{"name", "next"}});
    ASSERT_TRUE(next);
    EXPECT_EQ(next->env[key].to_string(), before);
  }

#ifdef _WIN32
  TEST_F(CaptureConfigTest, InheritedUnicodeEnvironmentUsesUtf8InCatalog) {
    auto host = boost::this_process::wenvironment();
    const std::wstring key = L"STREAM_KIT_UNICODE_ENV_TEST";
    const auto before = host[key].to_string();
    const bool empty = host[key].empty();
    auto restore = util::fail_guard([&]() {
      if (empty) {
        host[key].clear();
      } else {
        host[key] = before;
      }
    });
    host[key] = L"\u6e32\u67d3\u7a0b\u5e8f";
    auto parsed = parse({{"name", "unicode"}, {"cmd", "$(STREAM_KIT_UNICODE_ENV_TEST)"}});
    ASSERT_TRUE(parsed);
    EXPECT_EQ(parsed->apps.front().cmd, "\xe6\xb8\xb2\xe6\x9f\x93\xe7\xa8\x8b\xe5\xba\x8f");
    EXPECT_EQ(host[key].to_string(), L"\u6e32\u67d3\u7a0b\u5e8f");
  }
#endif

  TEST_F(CaptureConfigTest, CatalogChangesPreserveActiveLaunchAndScopeUntilStop) {
    auto original = parse({{"name", "active"}, {"exclude-global-prep-cmd", true}});
    ASSERT_TRUE(original);
    const auto id = std::stoi(original->apps.front().id);
    manager_.replace_catalog(std::move(*original));
    ASSERT_EQ(manager_.execute(id, std::make_shared<rtsp_stream::launch_session_t>()), 0);

    auto replacement = parse({{"name", "future"}, {"capture-mode", "application"}});
    ASSERT_TRUE(replacement);
    replacement->apps.front().id = std::to_string(id);
    manager_.replace_catalog(std::move(*replacement));
    EXPECT_EQ(manager_.running(), id);
    EXPECT_EQ(manager_.get_last_run_app_name(), "active");
    EXPECT_EQ(manager_.get_apps().front().name, "future");
    EXPECT_FALSE(manager_.uses_application_capture(id));
    manager_.terminate();
    EXPECT_EQ(manager_.running(), 0);
    EXPECT_TRUE(manager_.uses_application_capture(id));
  }

  TEST_F(CaptureConfigTest, RemovingCatalogEntryDoesNotDropRunningProcessOwnership) {
    auto original = parse({{"name", "active"}, {"exclude-global-prep-cmd", true}});
    ASSERT_TRUE(original);
    const auto id = std::stoi(original->apps.front().id);
    manager_.replace_catalog(std::move(*original));
    ASSERT_EQ(manager_.execute(id, std::make_shared<rtsp_stream::launch_session_t>()), 0);
    manager_.replace_catalog({});
    EXPECT_TRUE(manager_.get_apps().empty());
    EXPECT_EQ(manager_.running(), id);
    EXPECT_EQ(manager_.get_last_run_app_name(), "active");
    EXPECT_EQ(manager_.execute(id, std::make_shared<rtsp_stream::launch_session_t>()), 404);
    EXPECT_EQ(manager_.running(), id);
  }

  TEST_F(CaptureConfigTest, InvalidLaunchRequestsLeaveCurrentLaunchRunning) {
    auto original = parse({{"name", "active"}, {"exclude-global-prep-cmd", true}});
    ASSERT_TRUE(original);
    const auto id = std::stoi(original->apps.front().id);
    auto invalid = original->apps.front();
    invalid.id = "0";
    invalid.application_capture = true;
    original->apps.push_back(std::move(invalid));
    manager_.replace_catalog(std::move(*original));
    ASSERT_EQ(manager_.execute(id, std::make_shared<rtsp_stream::launch_session_t>()), 0);
    EXPECT_EQ(manager_.execute(-1, std::make_shared<rtsp_stream::launch_session_t>()), 404);
    EXPECT_EQ(manager_.execute(0, std::make_shared<rtsp_stream::launch_session_t>()), 400);
    EXPECT_EQ(manager_.execute(id, nullptr), 400);
    EXPECT_EQ(manager_.running(), id);
    EXPECT_EQ(manager_.get_last_run_app_name(), "active");
  }

  TEST_F(CaptureConfigTest, AppListSnapshotsSurviveConcurrentCatalogPublication) {
    auto original = parse({{"name", "first"}});
    ASSERT_TRUE(original);
    manager_.replace_catalog(std::move(*original));
    auto snapshot = manager_.get_apps();
    auto replacement = parse({{"name", "next"}});
    ASSERT_TRUE(replacement);
    std::atomic<bool> invalid {false};
    std::jthread reader([&]() {
      for (int i = 0; i < 1000; ++i) {
        const auto apps = manager_.get_apps();
        if (apps.size() != 1 || (apps.front().name != "first" && apps.front().name != "next")) {
          invalid = true;
        }
      }
    });
    for (int i = 0; i < 100; ++i) {
      manager_.replace_catalog(*replacement);
    }
    reader.join();
    EXPECT_FALSE(invalid);
    EXPECT_EQ(snapshot.front().name, "first");
    snapshot.clear();
    EXPECT_EQ(manager_.get_apps().front().name, "next");
  }
}  // namespace
