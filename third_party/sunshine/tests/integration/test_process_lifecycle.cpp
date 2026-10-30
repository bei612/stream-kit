/**
 * @file tests/integration/test_process_lifecycle.cpp
 * @brief Opt-in process ownership acceptance across application catalog updates.
 */
#ifdef _WIN32
  #include "src/platform/windows/utf_utils.h"
  #include "src/process.h"

  #include <cstdlib>
  #include <filesystem>
  #include <gtest/gtest.h>
  #include <thread>

namespace {
  TEST(ProcessLifecycleIntegrationTest, DISABLED_CatalogPublicationRetainsOwnedRendererUntilExplicitStop) {
    const auto executable = _wgetenv(L"STREAM_KIT_EXAMPLE_PATH");
    if (!executable || !*executable) {
      GTEST_SKIP() << "Set STREAM_KIT_EXAMPLE_PATH to the built checkerboard.exe";
    }
    ASSERT_TRUE(std::filesystem::is_regular_file(executable));
    proc::ctx_t app {};
    app.id = "617";
    app.name = "Lifecycle acceptance";
    app.cmd = "\"" + utf_utils::to_utf8(executable) + "\"";
    app.working_dir = utf_utils::to_utf8(std::filesystem::path(executable).parent_path().wstring());
    app.wait_all = true;
    app.application_capture = true;
    app.exit_timeout = std::chrono::seconds(3);
    proc::proc_t manager;
    manager.replace_catalog({proc::current_environment(), {app}});
    auto cleanup = util::fail_guard([&]() {
      manager.terminate();
    });
    auto session = std::make_shared<rtsp_stream::launch_session_t>();
    ASSERT_EQ(manager.execute(617, session), 0);
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
    app.name = "Next launch";
    app.application_capture = false;
    manager.replace_catalog({proc::current_environment(), {app}});
    EXPECT_EQ(manager.running(), 617);
    EXPECT_EQ(manager.get_last_run_app_name(), "Lifecycle acceptance");
    EXPECT_TRUE(manager.uses_application_capture(617));
    EXPECT_EQ(manager.capture_target(), target);
    EXPECT_EQ(target->renderer(), renderer);
    EXPECT_TRUE(renderer->alive());

    manager.replace_catalog({});
    EXPECT_EQ(manager.execute(617, session), 404);
    EXPECT_EQ(manager.running(), 617);
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
