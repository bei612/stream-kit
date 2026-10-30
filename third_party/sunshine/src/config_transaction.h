/**
 * @file src/config_transaction.h
 * @brief Shared serialization and bounded reads for encoder configuration writers.
 */
#pragma once

#include <filesystem>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace config_transaction {
  inline std::mutex mutex;  ///< Serializes API reads/commits and automatic option persistence.
  inline constexpr std::size_t max_bytes = 1024 * 1024;  ///< Maximum desired configuration size.
  /** @brief Evidence captured only after startup configuration application succeeds. */
  struct loaded_t {
    std::string revision;  ///< Strong hash of the exact file bytes passed to the startup parser.
    std::string instance_id;  ///< Random identity of this successful startup configuration load.
    std::vector<std::string> overridden_keys;  ///< Command-line override names; never their values.
  };
  inline loaded_t loaded;  ///< Startup evidence protected by mutex; API saves never update it.

  /** @brief Read a complete bounded regular configuration file. Caller holds mutex.
   * @param path Native configuration path.
   * @return File bytes, or empty defaults when the file does not exist.
   * @throws std::runtime_error On inaccessible, nonregular or oversized input.
   */
  inline std::string read(const std::filesystem::path &path) {
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory || status.type() == std::filesystem::file_type::not_found) {
      return {};
    }
    if (error || !std::filesystem::is_regular_file(status)) {
      throw std::runtime_error("Encoder configuration is unavailable");
    }
    std::ifstream file(path, std::ios::binary);
    if (!file) {
      throw std::runtime_error("Encoder configuration is unavailable");
    }
    std::string result;
    char buffer[8192];
    while (file) {
      file.read(buffer, sizeof(buffer));
      const auto count = static_cast<std::size_t>(file.gcount());
      if (count > max_bytes - result.size()) {
        throw std::runtime_error("Encoder configuration exceeds the size limit");
      }
      result.append(buffer, count);
    }
    if (!file.eof()) {
      throw std::runtime_error("Encoder configuration could not be read completely");
    }
    return result;
  }
}  // namespace config_transaction
