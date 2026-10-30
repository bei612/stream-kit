/**
 * @file src/app_registry.h
 * @brief Serialized, validated application catalog transactions shared by management APIs.
 */
#pragma once

#include <functional>
#include <nlohmann/json.hpp>
#include <string>

namespace proc {
  class proc_t;
}

namespace app_registry {
  /** @brief Maximum serialized catalog size accepted by the management API. */
  constexpr std::size_t max_catalog_bytes = 8 * 1024 * 1024;

  /** @brief Read a complete catalog while excluding an in-progress transaction. @param path UTF-8 catalog path. @return Parsed catalog. @throws std::exception On invalid or unreadable input. */
  nlohmann::json read(const std::string &path);

  /**
   * @brief Validate, persist and publish one catalog mutation without replacing live processes.
   * @param path UTF-8 catalog path.
   * @param manager Process manager receiving configuration for future launches.
   * @param mutation Callback applied to a private copy while holding the registry transaction lock.
   * @return Committed catalog.
   * @throws std::exception On invalid input or I/O failure. A post-rename durability failure still publishes the committed configuration.
   */
  nlohmann::json update(const std::string &path, proc::proc_t &manager, const std::function<void(nlohmann::json &)> &mutation);

  /** @brief Insert or replace exactly one owned application by immutable UUID. @param path Catalog path. @param manager Runtime manager. @param id Canonical UUID. @param app Native application configuration. @return Committed native application record. */
  nlohmann::json upsert(const std::string &path, proc::proc_t &manager, const std::string &id, nlohmann::json app);

  /** @brief Delete only the application carrying the requested ownership UUID. @param path Catalog path. @param manager Runtime manager. @param id Canonical UUID. @return True when an entry was removed, false when already absent. */
  bool erase(const std::string &path, proc::proc_t &manager, const std::string &id);
}  // namespace app_registry
