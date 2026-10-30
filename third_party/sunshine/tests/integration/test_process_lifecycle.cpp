/**
 * @file tests/integration/test_process_lifecycle.cpp
 * @brief Opt-in process ownership acceptance across application catalog updates.
 */
#ifdef _WIN32
  #include "src/app_registry.h"
  #include "src/platform/windows/utf_utils.h"
  #include "src/process.h"
  #include "src/uuid.h"

  #include <algorithm>
  #include <cctype>
  #include <cstdlib>
  #include <filesystem>
  #include <fstream>
  #include <gtest/gtest.h>
  #include <thread>

namespace {
  TEST(ProcessLifecycleIntegrationTest, DISABLED_CatalogPublicationRetainsOwnedRendererUntilExplicitStop) {
    const auto executable = _wgetenv(L"STREAM_KIT_EXAMPLE_PATH");
    if (!executable || !*executable) {
      GTEST_SKIP() << "Set STREAM_KIT_EXAMPLE_PATH to the built checkerboard.exe";
    }
    ASSERT_TRUE(std::filesystem::is_regular_file(executable));
    auto id = uuid_util::uuid_t::generate().string();
    // The legacy native UUID formatter emits uppercase hex; the managed API
    // uses the same canonical lowercase representation as the Go controller.
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char value) {
      return static_cast<char>(std::tolower(value));
    });
    const auto game_id = std::stoi(proc::calculate_managed_app_id(id));
    const auto path = std::filesystem::path(SUNSHINE_TEST_BIN_DIR) / ("lifecycle-" + id + ".json");
    std::ofstream(path) << R"({"env":{},"apps":[]})";
    auto remove_catalog = util::fail_guard([&]() {
      std::error_code ignored;
      std::filesystem::remove(path, ignored);
    });
    nlohmann::json app {
      {"name", "Lifecycle acceptance"},
      {"cmd", "\"" + utf_utils::to_utf8(executable) + "\""},
      {"working-dir", utf_utils::to_utf8(std::filesystem::path(executable).parent_path().wstring())},
      {"wait-all", true},
      {"auto-detach", false},
      {"capture-mode", "application"},
      {"exit-timeout", 3},
      {"exclude-global-prep-cmd", true}
    };
    proc::proc_t manager;
    app_registry::upsert(path.string(), manager, id, app);
    auto cleanup = util::fail_guard([&]() {
      manager.terminate();
    });
    auto session = std::make_shared<rtsp_stream::launch_session_t>();
    ASSERT_EQ(manager.execute(game_id, session), 0);
    const auto target = manager.capture_target();
    ASSERT_NE(target, nullptr);
    ASSERT_EQ(session->capture_target, target);
    ASSERT_TRUE(target->alive());

    capture::renderer_ptr renderer;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!renderer && std::chrono::steady_clock::now() < deadline) {
      renderer = target->renderer();
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    ASSERT_NE(renderer, nullptr);
    app["name"] = "Next launch";
    app["capture-mode"] = "desktop";
    app_registry::upsert(path.string(), manager, id, app);
    EXPECT_EQ(manager.get_apps().front().id, std::to_string(game_id));
    EXPECT_EQ(manager.running(), game_id);
    EXPECT_EQ(manager.get_last_run_app_name(), "Lifecycle acceptance");
    EXPECT_TRUE(manager.uses_application_capture(game_id));
    EXPECT_EQ(manager.capture_target(), target);
    EXPECT_EQ(target->renderer(), renderer);
    EXPECT_TRUE(renderer->alive());

    EXPECT_TRUE(app_registry::erase(path.string(), manager, id));
    EXPECT_TRUE(manager.get_apps().empty());
    EXPECT_EQ(manager.execute(game_id, session), 404);
    EXPECT_EQ(manager.running(), game_id);
    EXPECT_EQ(manager.capture_target(), target);
    EXPECT_TRUE(target->alive());
    manager.terminate();
    EXPECT_EQ(manager.running(), 0);
    EXPECT_EQ(manager.capture_target(), nullptr);
    EXPECT_FALSE(target->alive());
    EXPECT_FALSE(renderer->alive());
  }

}  // namespace
#endif
