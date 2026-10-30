/**
 * @file src/include/lizardbyte/common/env.h
 * @brief Environment variable helper declarations.
 */
#pragma once

// standard includes
#include <string>

namespace lizardbyte::common {
  /**
   * @brief Get an environment variable.
   * @param name The name of the environment variable.
   * @param value Reference to write the environment variable value into.
   * @return true if value was updated, false if the environment variable did not exist.
   */
  [[nodiscard]] bool get_env(const std::string &name, std::string &value);

  /**
   * @brief Get an environment variable.
   * @param name The name of the environment variable.
   * @return Environment variable value, or an empty string if the variable does not exist.
   */
  [[nodiscard]] std::string get_env(const std::string &name);

  /**
   * @brief Set an environment variable.
   * @param name The name of the environment variable.
   * @param value The value to set the environment variable to.
   * @return 0 on success, non-zero on failure.
   */
  int set_env(const std::string &name, const std::string &value);

  /**
   * @brief Append a string to an environment variable if it does not already contain it.
   * @param name The name of the environment variable.
   * @param value The value to append to the environment variable.
   * @param separator Optional separator for the new value if it is not the first one.
   * @return 0 on success, non-zero on failure.
   */
  int append_env(const std::string &name, const std::string &value, const std::string &separator = "");

  /**
   * @brief Unset an environment variable.
   * @param name The name of the environment variable.
   * @return 0 on success, non-zero on failure.
   */
  int unset_env(const std::string &name);
}  // namespace lizardbyte::common
