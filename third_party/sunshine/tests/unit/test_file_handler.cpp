/**
 * @file tests/unit/test_file_handler.cpp
 * @brief Test src/file_handler.*.
 */

// test includes
#include "../tests_common.h"

// standard includes
#include <format>

// local includes
#include <src/file_handler.h>
#ifdef _WIN32
  #include <Windows.h>
#endif

TEST(ResourcePathTest, AbsoluteInstallPathsAndUtf8ArePreserved) {
  const auto root = std::filesystem::absolute(std::filesystem::path(SUNSHINE_TEST_BIN_DIR));
  const auto expected = root / file_handler::from_utf8("assets/\xe6\xb5\x8b\xe8\xaf\x95.png");
  const auto encoded = expected.generic_u8string();
  const std::string path(encoded.begin(), encoded.end());
  EXPECT_EQ(file_handler::resource_path(path), expected.lexically_normal());
  EXPECT_EQ(file_handler::resource_string(path), path);
}

#ifdef _WIN32
TEST(ResourcePathTest, PackagedResourcesDoNotFollowCurrentWorkingDirectory) {
  const auto original = std::filesystem::current_path();
  auto restore = util::fail_guard([&]() {
    std::filesystem::current_path(original);
  });
  const auto before = file_handler::resource_path("assets/shaders/test.hlsl");
  std::filesystem::current_path(std::filesystem::temp_directory_path());
  EXPECT_EQ(file_handler::resource_path("assets/shaders/test.hlsl"), before);
  EXPECT_TRUE(before.is_absolute());
  std::vector<wchar_t> executable(32768);
  const auto length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  ASSERT_GT(length, 0U);
  EXPECT_EQ(before, std::filesystem::path(std::wstring(executable.data(), length)).parent_path() / "assets/shaders/test.hlsl");
}
#endif

struct FileHandlerParentDirectoryTest: BaseTest, testing::WithParamInterface<std::tuple<std::string, std::string>> {};

TEST_P(FileHandlerParentDirectoryTest, Run) {
  auto [input, expected] = GetParam();
  EXPECT_EQ(file_handler::get_parent_directory(input), expected);
}

INSTANTIATE_TEST_SUITE_P(
  FileHandlerTests,
  FileHandlerParentDirectoryTest,
  testing::Values(
    std::make_tuple("/path/to/file.txt", "/path/to"),
    std::make_tuple("/path/to/directory", "/path/to"),
    std::make_tuple("/path/to/directory/", "/path/to")
  )
);

struct FileHandlerMakeDirectoryTest: BaseTest, testing::WithParamInterface<std::tuple<std::string, bool, bool>> {};

TEST_P(FileHandlerMakeDirectoryTest, Run) {
  auto [input, expected, remove] = GetParam();
  const std::string test_dir = platf::appdata().string() + "/tests/path/";
  input = test_dir + input;

  EXPECT_EQ(file_handler::make_directory(input), expected);
  EXPECT_TRUE(std::filesystem::exists(input));

  // remove test directory
  if (remove) {
    std::filesystem::remove_all(test_dir);
    EXPECT_FALSE(std::filesystem::exists(test_dir));
  }
}

INSTANTIATE_TEST_SUITE_P(
  FileHandlerTests,
  FileHandlerMakeDirectoryTest,
  testing::Values(
    std::make_tuple("dir_123", true, false),
    std::make_tuple("dir_123", true, true),
    std::make_tuple("dir_123/abc", true, false),
    std::make_tuple("dir_123/abc", true, true)
  )
);

struct FileHandlerTests: BaseTest, testing::WithParamInterface<std::tuple<int, std::string>> {};

INSTANTIATE_TEST_SUITE_P(
  TestFiles,
  FileHandlerTests,
  testing::Values(
    std::make_tuple(0, ""),  // empty file
    std::make_tuple(1, "a"),  // single character
    std::make_tuple(2, "Mr. Blue Sky - Electric Light Orchestra"),  // single line
    std::make_tuple(3, R"(
Morning! Today's forecast calls for blue skies
The sun is shining in the sky
There ain't a cloud in sight
It's stopped raining
Everybody's in the play
And don't you know, it's a beautiful new day
Hey, hey, hey!
Running down the avenue
See how the sun shines brightly in the city
All the streets where once was pity
Mr. Blue Sky is living here today!
Hey, hey, hey!
    )")  // multi-line
  )
);

TEST_P(FileHandlerTests, WriteFileTest) {
  auto [fileNum, content] = GetParam();
  const std::string fileName = std::format("write_file_test_{}.txt", fileNum);
  EXPECT_EQ(file_handler::write_file(fileName.c_str(), content), 0);
}

TEST_P(FileHandlerTests, ReadFileTest) {
  auto [fileNum, content] = GetParam();
  const std::string fileName = std::format("write_file_test_{}.txt", fileNum);
  EXPECT_EQ(file_handler::read_file(fileName.c_str()), content);
}

TEST(FileHandlerTests, ReadMissingFileTest) {
  // read missing file
  EXPECT_EQ(file_handler::read_file("non-existing-file.txt"), "");
}
