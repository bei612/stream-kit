/**
 * @file tests/unit/test_app_registry.cpp
 * @brief Ownership, atomic persistence and concurrent catalog publication coverage.
 */
#include "src/app_registry.h"
#include "src/file_handler.h"
#include "src/process.h"
#include "src/uuid.h"

#include <atomic>
#include <fstream>
#include <gtest/gtest.h>
#include <thread>

namespace {
  constexpr auto first_id = "11111111-1111-4111-8111-111111111111";  ///< First owned application fixture.
  constexpr auto second_id = "22222222-2222-4222-8222-222222222222";  ///< Independent application fixture.

  /** @brief Own a unique directory and a process-free runtime manager. */
  class AppRegistryTest: public ::testing::Test {
  protected:
    /** @brief Create a catalog containing an unrelated legacy application. */
    void SetUp() override {
      directory = std::filesystem::path(SUNSHINE_TEST_BIN_DIR) / ("registry-" + uuid_util::uuid_t::generate().string());
      std::filesystem::create_directory(directory);
      path = (directory / "apps.json").string();
      original = {{"env", nlohmann::json::object()}, {"apps", nlohmann::json::array({{{"name", "Shared name"}, {"cmd", "unrelated"}}})}};
      std::ofstream(path) << original.dump();
      auto parsed = proc::parse(path);
      ASSERT_TRUE(parsed);
      manager.replace_catalog(std::move(*parsed));
    }

    /** @brief Remove only this fixture's unique directory. */
    void TearDown() override {
      std::filesystem::remove_all(directory);
    }

    std::filesystem::path directory;  ///< Test-owned temporary directory.
    std::string path;  ///< Test catalog path.
    nlohmann::json original;  ///< Legacy registration that must never be claimed by name.
    proc::proc_t manager;  ///< Runtime manager with no process launches.
  };

  TEST_F(AppRegistryTest, UpsertIsIdempotentAndDoesNotClaimSameNamedLegacyApp) {
    app_registry::upsert(path, manager, first_id, {{"name", "Shared name"}, {"cmd", "owned"}});
    const auto game_id = manager.get_apps().back().id;
    app_registry::upsert(path, manager, first_id, {{"name", "Renamed"}, {"cmd", "new-command"}, {"image-path", "other.png"}});
    const auto tree = app_registry::read(path);
    ASSERT_EQ(tree["apps"].size(), 2U);
    EXPECT_EQ(tree["apps"][0], original["apps"][0]);
    EXPECT_EQ(tree["apps"][1]["stream-kit-id"], first_id);
    EXPECT_EQ(manager.get_apps().back().id, game_id);
    EXPECT_EQ(game_id, proc::calculate_managed_app_id(first_id));
    EXPECT_GT(std::stoi(game_id), 0);
    EXPECT_EQ(manager.running(), 0);
  }

  TEST_F(AppRegistryTest, DeleteIsScopedAndIdempotentAcrossCatalogReordering) {
    app_registry::upsert(path, manager, first_id, {{"name", "Same"}});
    app_registry::upsert(path, manager, second_id, {{"name", "Same"}});
    app_registry::update(path, manager, [](auto &tree) {
      std::reverse(tree["apps"].begin(), tree["apps"].end());
    });
    EXPECT_TRUE(app_registry::erase(path, manager, first_id));
    EXPECT_FALSE(app_registry::erase(path, manager, first_id));
    const auto tree = app_registry::read(path);
    ASSERT_EQ(tree["apps"].size(), 2U);
    EXPECT_EQ(tree["apps"][0]["stream-kit-id"], second_id);
    EXPECT_EQ(tree["apps"][1], original["apps"][0]);
  }

  TEST_F(AppRegistryTest, RejectsInvalidIdentityAndInvalidCandidateBeforeWriting) {
    const auto bytes = file_handler::read_file(path.c_str());
    for (const auto id : {"", "../apps", "00000000-0000-0000-0000-000000000000", "AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}) {
      EXPECT_THROW(app_registry::upsert(path, manager, id, {{"name", "invalid"}}), std::invalid_argument);
    }
    EXPECT_THROW(app_registry::upsert(path, manager, first_id, {{"name", "mismatch"}, {"stream-kit-id", second_id}}), std::invalid_argument);
    EXPECT_THROW(app_registry::upsert(path, manager, first_id, {{"name", "invalid"}, {"capture-mode", "window"}}), std::invalid_argument);
    for (const auto &invalid : std::vector<nlohmann::json> {
           {{"name", 42}},
           {{"name", ""}},
           {{"name", "bad"}, {"index", -1}},
           {{"name", "bad"}, {"cmd", 42}},
           {{"name", "bad"}, {"auto-detach", "false"}},
           {{"name", "bad"}, {"exit-timeout", -1}},
           {{"name", "bad"}, {"exit-timeout", 0.5}},
           {{"name", "bad"}, {"prep-cmd", "do"}},
           {{"name", "bad"}, {"prep-cmd", nlohmann::json::array({{{"do", 42}}})}},
           {{"name", "bad"}, {"detached", nlohmann::json::array({42})}}
         }) {
      EXPECT_THROW(app_registry::upsert(path, manager, first_id, invalid), std::invalid_argument) << invalid.dump();
    }
    EXPECT_THROW(app_registry::update(path, manager, [](auto &tree) {
                   tree["apps"] = nullptr;
                 }),
                 std::invalid_argument);
    EXPECT_EQ(file_handler::read_file(path.c_str()), bytes);
    ASSERT_EQ(manager.get_apps().size(), 1U);
    EXPECT_EQ(manager.get_apps().front().cmd, "unrelated");
  }

  TEST_F(AppRegistryTest, RejectsDuplicateUuidsAndGamestreamCollisions) {
    EXPECT_FALSE(proc::parse_content(nlohmann::json {{"env", nlohmann::json::object()}, {"apps", {{{"name", "one"}, {"stream-kit-id", first_id}}, {{"name", "two"}, {"stream-kit-id", first_id}}}}}.dump()));
    constexpr auto collision_a = "8cb357f1-2fed-9e37-194d-346247e45bc2";
    constexpr auto collision_b = "33256e13-420f-6d60-5bc4-6c911c92d0fa";
    ASSERT_EQ(proc::calculate_managed_app_id(collision_a), "631720960");
    ASSERT_EQ(proc::calculate_managed_app_id(collision_b), "631720960");
    EXPECT_FALSE(proc::parse_content(nlohmann::json {{"env", nlohmann::json::object()}, {"apps", {{{"name", "one"}, {"stream-kit-id", collision_a}}, {{"name", "two"}, {"stream-kit-id", collision_b}}}}}.dump()));
    // Owned IDs remain independent of other applications' names and positions.
    app_registry::upsert(path, manager, first_id, {{"name", "Shared name"}});
    const auto before = manager.get_apps().back().id;
    app_registry::update(path, manager, [](auto &tree) {
      tree["apps"].insert(tree["apps"].begin(), nlohmann::json {{"name", "other"}});
    });
    EXPECT_EQ(manager.get_apps().back().id, before);
  }

  TEST_F(AppRegistryTest, ConcurrentOwnedUpdatesDoNotLoseOtherApplications) {
    std::atomic<int> failures {0};
    auto writer = [&](const char *id) {
      try {
        for (int i = 0; i < 12; ++i) {
          app_registry::upsert(path, manager, id, {{"name", "Concurrent"}, {"cmd", std::to_string(i)}});
        }
      } catch (...) {
        ++failures;
      }
    };
    std::jthread first(writer, first_id);
    std::jthread second(writer, second_id);
    first.join();
    second.join();
    EXPECT_EQ(failures, 0);
    const auto tree = app_registry::read(path);
    ASSERT_EQ(tree["apps"].size(), 3U);
    EXPECT_EQ(tree["apps"][0], original["apps"][0]);
    EXPECT_EQ(tree["apps"][1]["cmd"], "11");
    EXPECT_EQ(tree["apps"][2]["cmd"], "11");
  }

  TEST_F(AppRegistryTest, AtomicReplacementCreatesAndReplacesUnicodeFileWithoutDebris) {
    const auto unicode_path = directory / std::filesystem::path(u8"\xe5\xba\x94\xe7\x94\xa8.json");
    const auto created = file_handler::atomic_replace(unicode_path, "first");
    ASSERT_FALSE(created.error) << created.error.message();
    ASSERT_TRUE(created.committed);
    const auto replaced = file_handler::atomic_replace(unicode_path, "second");
    ASSERT_FALSE(replaced.error) << replaced.error.message();
    ASSERT_TRUE(replaced.committed);
    std::ifstream input(unicode_path);
    std::string value;
    input >> value;
    EXPECT_EQ(value, "second");
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(directory), std::filesystem::directory_iterator()), 2);
  }

  TEST_F(AppRegistryTest, AtomicPreparationFailureNeverTruncatesExistingData) {
    const auto failed = file_handler::atomic_replace(directory, "cannot-replace-directory");
    EXPECT_FALSE(failed.committed);
    EXPECT_TRUE(failed.error);
    EXPECT_EQ(app_registry::read(path), original);
    const auto missing = file_handler::atomic_replace(directory / "missing" / "apps.json", "data");
    EXPECT_FALSE(missing.committed);
    EXPECT_TRUE(missing.error);
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(directory), std::filesystem::directory_iterator()), 1);
  }

#ifdef _WIN32
  TEST_F(AppRegistryTest, FailedRenameDoesNotPublishCandidateOrDeleteOriginal) {
    const auto native_path = std::filesystem::path(path).wstring();
    const auto held = CreateFileW(native_path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    ASSERT_NE(held, INVALID_HANDLE_VALUE);
    auto close = util::fail_guard([&]() {
      CloseHandle(held);
    });
    EXPECT_THROW(app_registry::upsert(path, manager, first_id, {{"name", "blocked"}}), std::system_error);
    EXPECT_EQ(app_registry::read(path), original);
    EXPECT_EQ(manager.get_apps().size(), 1U);
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(directory), std::filesystem::directory_iterator()), 1);
  }
#endif
}  // namespace
