/**
 * @file file_handler.cpp
 * @brief Definitions for file handling functions.
 */

// standard includes
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <vector>

// local includes
#include "file_handler.h"
#include "logging.h"
#include "utility.h"

#ifdef _WIN32
  #include <Windows.h>
#else
  #include <fcntl.h>
  #include <sys/stat.h>
  #include <unistd.h>
#endif

#include "uuid.h"

namespace file_handler {
  std::filesystem::path from_utf8(std::string_view path) {
    return std::filesystem::path(std::u8string(path.begin(), path.end()));
  }

  std::filesystem::path resource_path(std::string_view path) {
    auto resolved = from_utf8(path);
#ifdef _WIN32
    if (resolved.is_relative()) {
      std::vector<wchar_t> executable(32768);
      const auto length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
      if (length == 0 || length >= executable.size()) {
        throw std::runtime_error("Cannot locate executable resource directory");
      }
      resolved = std::filesystem::path(std::wstring(executable.data(), length)).parent_path() / resolved;
    }
#endif
    return resolved.lexically_normal();
  }

  std::string resource_string(std::string_view path) {
    const auto encoded = resource_path(path).generic_u8string();
    return {encoded.begin(), encoded.end()};
  }

  replace_result_t atomic_replace(const std::filesystem::path &path, std::string_view contents) {
    auto temporary = path;
    temporary += ".tmp-" + uuid_util::uuid_t::generate().string();
    bool created = false;
    auto cleanup = util::fail_guard([&]() {
      if (created) {
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
      }
    });
#ifdef _WIN32
    // Preserve the destination's DACL when replacing it with a newly created file.
    // Do not relax a restrictive configuration ACL to the directory's defaults.
    SECURITY_ATTRIBUTES attributes {sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
    std::vector<unsigned char> security;
    const auto flags = GetFileAttributesW(path.c_str());
    if (flags != INVALID_FILE_ATTRIBUTES) {
      if (flags & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) {
        return {false, std::make_error_code(std::errc::invalid_argument)};
      }
      DWORD required = 0;
      GetFileSecurityW(path.c_str(), DACL_SECURITY_INFORMATION, nullptr, 0, &required);
      if (required == 0) {
        return {false, {static_cast<int>(GetLastError()), std::system_category()}};
      }
      security.resize(required);
      if (!GetFileSecurityW(path.c_str(), DACL_SECURITY_INFORMATION, security.data(), required, &required)) {
        return {false, {static_cast<int>(GetLastError()), std::system_category()}};
      }
      attributes.lpSecurityDescriptor = security.data();
    } else if (GetLastError() != ERROR_FILE_NOT_FOUND) {
      return {false, {static_cast<int>(GetLastError()), std::system_category()}};
    }
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      return {false, {static_cast<int>(GetLastError()), std::system_category()}};
    }
    created = true;
    auto close = util::fail_guard([&]() {
      if (file != INVALID_HANDLE_VALUE) {
        CloseHandle(file);
      }
    });
    while (!contents.empty()) {
      DWORD written = 0;
      const auto count = static_cast<DWORD>(std::min<std::size_t>(contents.size(), 1024 * 1024));
      if (!WriteFile(file, contents.data(), count, &written, nullptr)) {
        return {false, {static_cast<int>(GetLastError()), std::system_category()}};
      }
      if (written == 0) {
        return {false, std::make_error_code(std::errc::io_error)};
      }
      contents.remove_prefix(written);
    }
    if (!FlushFileBuffers(file)) {
      return {false, {static_cast<int>(GetLastError()), std::system_category()}};
    }
    const auto closed = CloseHandle(file);
    file = INVALID_HANDLE_VALUE;
    if (!closed) {
      return {false, {static_cast<int>(GetLastError()), std::system_category()}};
    }
    if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      return {false, {static_cast<int>(GetLastError()), std::system_category()}};
    }
    return {true, {}};
#else
    const auto directory = path.has_parent_path() ? path.parent_path() : std::filesystem::path(".");
    const int parent = ::open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (parent < 0) {
      return {false, {errno, std::generic_category()}};
    }
    auto close_parent = util::fail_guard([&]() {
      ::close(parent);
    });
    struct stat metadata {};
    mode_t mode = 0600;
    if (::lstat(path.c_str(), &metadata) == 0) {
      if (!S_ISREG(metadata.st_mode)) {
        return {false, std::make_error_code(std::errc::invalid_argument)};
      }
      mode = metadata.st_mode & 0777;
    } else if (errno != ENOENT) {
      return {false, {errno, std::generic_category()}};
    }
    int file = ::open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (file < 0) {
      return {false, {errno, std::generic_category()}};
    }
    created = true;
    auto close = util::fail_guard([&]() {
      if (file >= 0) {
        ::close(file);
      }
    });
    while (!contents.empty()) {
      const auto written = ::write(file, contents.data(), std::min<std::size_t>(contents.size(), 1024 * 1024));
      if (written < 0 && errno == EINTR) {
        continue;
      }
      if (written <= 0) {
        return {false, {written < 0 ? errno : EIO, std::generic_category()}};
      }
      contents.remove_prefix(static_cast<std::size_t>(written));
    }
    if (::fchmod(file, mode) != 0 || ::fsync(file) != 0) {
      return {false, {errno, std::generic_category()}};
    }
    const int closed = ::close(file);
    file = -1;
    if (closed != 0 || ::rename(temporary.c_str(), path.c_str()) != 0) {
      return {false, {errno, std::generic_category()}};
    }
    if (::fsync(parent) != 0) {
      return {true, {errno, std::generic_category()}};
    }
    return {true, {}};
#endif
  }

  std::string get_parent_directory(const std::string &path) {
    // remove any trailing path separators
    std::string trimmed_path = path;
    while (!trimmed_path.empty() && trimmed_path.back() == '/') {
      trimmed_path.pop_back();
    }

    std::filesystem::path p(trimmed_path);
    return p.parent_path().string();
  }

  bool make_directory(const std::string &path) {
    // first, check if the directory already exists
    if (std::filesystem::exists(path)) {
      return true;
    }

    return std::filesystem::create_directories(path);
  }

  std::string read_file(const char *path) {
    const auto native_path = from_utf8(path);
    if (!std::filesystem::exists(native_path)) {
      BOOST_LOG(debug) << "Missing file: " << path;
      return {};
    }

    std::ifstream in(native_path);
    return std::string {(std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()};
  }

  int write_file(const char *path, const std::string_view &contents) {
    std::ofstream out(path);

    if (!out.is_open()) {
      return -1;
    }

    out << contents;

    return 0;
  }
}  // namespace file_handler
