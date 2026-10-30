/**
 * @file file_handler.h
 * @brief Declarations for file handling functions.
 */
#pragma once

// standard includes
#include <filesystem>
#include <string>
#include <system_error>

/**
 * @brief Responsible for file handling functions.
 */
namespace file_handler {
  /** @brief Convert a UTF-8 API path to the platform-native filesystem representation. @param path UTF-8 path bytes. @return Native filesystem path. */
  std::filesystem::path from_utf8(std::string_view path);

  /** @brief Distinguish a failed preparation from a committed replacement whose directory flush failed. */
  struct replace_result_t {
    bool committed {false};  ///< Destination now contains the complete replacement.
    std::error_code error;  ///< Preparation, replacement or durability error; empty on success.
  };

  /**
   * @brief Flush a same-directory temporary file and atomically replace a configuration file.
   * @param path Destination path; its directory must already exist.
   * @param contents Complete replacement bytes.
   * @return Commit state and any I/O error. Never truncates the destination in place.
   */
  replace_result_t atomic_replace(const std::filesystem::path &path, std::string_view contents);

  /**
   * @brief Get the parent directory of a file or directory.
   * @param path The path of the file or directory.
   * @return The parent directory.
   * @examples
   * std::string parent_dir = get_parent_directory("path/to/file");
   * @examples_end
   */
  std::string get_parent_directory(const std::string &path);

  /**
   * @brief Make a directory.
   * @param path The path of the directory.
   * @return `true` on success, `false` on failure.
   * @examples
   * bool dir_created = make_directory("path/to/directory");
   * @examples_end
   */
  bool make_directory(const std::string &path);

  /**
   * @brief Read a file to string.
   * @param path The path of the file.
   * @return The contents of the file.
   * @examples
   * std::string contents = read_file("path/to/file");
   * @examples_end
   */
  std::string read_file(const char *path);

  /**
   * @brief Writes a file.
   * @param path The path of the file.
   * @param contents The contents to write.
   * @return ``0`` on success, ``-1`` on failure.
   * @examples
   * int write_status = write_file("path/to/file", "file contents");
   * @examples_end
   */
  int write_file(const char *path, const std::string_view &contents);
}  // namespace file_handler
