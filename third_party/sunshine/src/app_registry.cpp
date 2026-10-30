/**
 * @file src/app_registry.cpp
 * @brief Persistent application registry transactions and immutable ownership lookup.
 */
#include "app_registry.h"

#include "file_handler.h"
#include "process.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <mutex>

namespace app_registry {
  namespace {
    std::mutex registry_mutex;  ///< One writer across both native and Stream-Kit management APIs.

    /** @brief Read and structurally validate a bounded catalog under the caller's registry lock. @param path UTF-8 catalog path. @return Catalog with object environment and array applications. */
    nlohmann::json read_locked(const std::string &path) {
      std::ifstream input(file_handler::from_utf8(path), std::ios::binary | std::ios::ate);
      if (!input) {
        throw std::runtime_error("Cannot open application catalog");
      }
      const auto size = input.tellg();
      if (size < 0 || size > static_cast<std::streamoff>(max_catalog_bytes)) {
        throw std::runtime_error("Application catalog is unreadable or exceeds the size limit");
      }
      std::string content(static_cast<std::size_t>(size), '\0');
      input.seekg(0);
      input.read(content.data(), content.size());
      if (!input || input.peek() != std::char_traits<char>::eof()) {
        throw std::runtime_error("Application catalog changed while reading");
      }
      auto tree = nlohmann::json::parse(content);
      if (!tree.is_object() || !tree.contains("env") || !tree["env"].is_object() || !tree.contains("apps") || !tree["apps"].is_array()) {
        throw std::invalid_argument("Application catalog requires env object and apps array");
      }
      return tree;
    }
  }  // namespace

  nlohmann::json read(const std::string &path) {
    std::lock_guard lock {registry_mutex};
    return read_locked(path);
  }

  nlohmann::json update(const std::string &path, proc::proc_t &manager, const std::function<void(nlohmann::json &)> &mutation) {
    std::lock_guard lock {registry_mutex};
    auto tree = read_locked(path);
    mutation(tree);
    if (!tree.is_object() || !tree.contains("env") || !tree["env"].is_object() || !tree.contains("apps") || !tree["apps"].is_array()) {
      throw std::invalid_argument("Invalid application catalog structure");
    }
    const auto content = tree.dump(4);
    if (content.size() > max_catalog_bytes) {
      throw std::invalid_argument("Application catalog exceeds the size limit");
    }
    auto catalog = proc::parse_content(content);
    if (!catalog) {
      throw std::invalid_argument("Application catalog failed validation");
    }
    const auto saved = file_handler::atomic_replace(file_handler::from_utf8(path), content);
    if (saved.committed) {
      manager.replace_catalog(std::move(*catalog));
    }
    if (saved.error) {
      throw std::system_error(saved.error, "Application catalog commit failed");
    }
    return tree;
  }

  nlohmann::json upsert(const std::string &path, proc::proc_t &manager, const std::string &id, nlohmann::json app) {
    if (!proc::valid_managed_id(id) || !app.is_object() || (app.contains("stream-kit-id") && app["stream-kit-id"] != id)) {
      throw std::invalid_argument("Invalid or mismatched application ownership UUID");
    }
    if (!app.contains("name") || !app["name"].is_string() || app["name"].get_ref<const std::string &>().empty() || app.contains("index")) {
      throw std::invalid_argument("Managed application requires a name and cannot use a catalog index");
    }
    for (const auto key : {"cmd", "working-dir", "output", "image-path"}) {
      if (app.contains(key) && !app[key].is_string()) {
        throw std::invalid_argument(std::string(key) + " must be a string");
      }
    }
    for (const auto key : {"elevated", "auto-detach", "wait-all", "exclude-global-prep-cmd"}) {
      if (app.contains(key) && !app[key].is_boolean()) {
        throw std::invalid_argument(std::string(key) + " must be a boolean");
      }
    }
    if (app.contains("exit-timeout") && (!app["exit-timeout"].is_number_integer() || app["exit-timeout"].get<std::int64_t>() < 0 || app["exit-timeout"].get<std::int64_t>() > std::numeric_limits<int>::max())) {
      throw std::invalid_argument("exit-timeout must be a non-negative supported integer");
    }
    for (const auto key : {"prep-cmd", "detached"}) {
      if (app.contains(key) && !app[key].is_array()) {
        throw std::invalid_argument(std::string(key) + " must be an array");
      }
    }
    if (app.contains("detached")) {
      for (const auto &command : app["detached"]) {
        if (!command.is_string()) {
          throw std::invalid_argument("detached commands must be strings");
        }
      }
    }
    if (app.contains("prep-cmd")) {
      for (const auto &command : app["prep-cmd"]) {
        if (!command.is_object() || (command.contains("do") && !command["do"].is_string()) ||
            (command.contains("undo") && !command["undo"].is_string()) ||
            (command.contains("elevated") && !command["elevated"].is_boolean())) {
          throw std::invalid_argument("Invalid prep command structure");
        }
      }
    }
    app["stream-kit-id"] = id;
    update(path, manager, [&](auto &tree) {
      auto &apps = tree["apps"];
      auto entry = std::find_if(apps.begin(), apps.end(), [&](const auto &value) {
        return value.value("stream-kit-id", std::string()) == id;
      });
      if (entry == apps.end()) {
        apps.push_back(app);
      } else {
        *entry = app;
      }
    });
    return app;
  }

  bool erase(const std::string &path, proc::proc_t &manager, const std::string &id) {
    if (!proc::valid_managed_id(id)) {
      throw std::invalid_argument("Invalid application ownership UUID");
    }
    bool removed = false;
    update(path, manager, [&](auto &tree) {
      auto &apps = tree["apps"];
      const auto size = apps.size();
      apps.erase(std::remove_if(apps.begin(), apps.end(), [&](const auto &value) {
                   return value.value("stream-kit-id", std::string()) == id;
                 }),
                 apps.end());
      removed = size != apps.size();
    });
    return removed;
  }
}  // namespace app_registry
