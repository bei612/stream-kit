/**
 * @file src/process.h
 * @brief Declarations for the startup and shutdown of the apps started by a streaming Session.
 */
#pragma once

#ifndef __kernel_entry
  /**
   * @def __kernel_entry
   * @brief Macro for kernel entry.
   */
  #define __kernel_entry
#endif

// standard includes
#include <mutex>
#include <optional>
#include <unordered_map>

// lib includes
#include <boost/process/v1.hpp>

// local includes
#include "config.h"
#include "platform/common.h"
#include "rtsp.h"
#include "utility.h"

/**
 * @def DEFAULT_APP_IMAGE_PATH
 * @brief Macro for DEFAULT APP IMAGE PATH.
 */
#define DEFAULT_APP_IMAGE_PATH SUNSHINE_ASSETS_DIR "/box.png"

namespace proc {
  /**
   * @brief Boost.Process pipe stream used for child-process I/O.
   */
  using file_t = util::safe_ptr_v2<FILE, int, fclose>;

  /**
   * @brief Parsed command arguments used when launching a child process.
   */
  typedef config::prep_cmd_t cmd_t;

  /**
   * pre_cmds -- guaranteed to be executed unless any of the commands fail.
   * detached -- commands detached from Sunshine
   * cmd -- Runs indefinitely until:
   *    No session is running and a different set of commands it to be executed
   *    Command exits
   * working_dir -- the process working directory. This is required for some games to run properly.
   * cmd_output --
   *    empty    -- The output of the commands are appended to the output of sunshine
   *    "null"   -- The output of the commands are discarded
   *    filename -- The output of the commands are appended to filename
   */
  struct ctx_t {
    std::vector<cmd_t> prep_cmds;  ///< Prep cmds.

    /**
     * Some applications, such as Steam, either exit quickly, or keep running indefinitely.
     *
     * Apps that launch normal child processes and terminate will be handled by the process
     * grouping logic (wait_all). However, apps that launch child processes indirectly or
     * into another process group (such as UWP apps) can only be handled by the auto-detach
     * heuristic which catches processes that exit 0 very quickly, but we won't have proper
     * process tracking for those.
     *
     * For cases where users just want to kick off a background process and never manage the
     * lifetime of that process, they can use detached commands for that.
     */
    std::vector<std::string> detached;

    std::string name;  ///< Human-readable name for this item.
    std::string cmd;  ///< Command line used to launch the application.
    std::string working_dir;  ///< Working dir.
    std::string output;  ///< Captured output from the launched process.
    std::string image_path;  ///< Image path.
    std::string id;  ///< Stable identifier for the configured application.
    std::string managed_id;  ///< Immutable Stream-Kit application UUID, empty for unmanaged entries.
    bool elevated {false};  ///< Whether the process should be launched elevated.
    bool auto_detach {false};  ///< Whether the process should detach automatically.
    bool wait_all {false};  ///< Whether Sunshine waits for all child processes.
    bool application_capture {false};  ///< Capture this launch's window and process audio instead of the desktop.
    std::chrono::seconds exit_timeout {};  ///< Exit timeout.
  };

  /** @brief Parsed configuration for future launches, independent of live process ownership. */
  struct catalog_t {
    boost::process::v1::environment env;  ///< Base environment copied into each new launch.
    std::vector<ctx_t> apps;  ///< Configured applications for subsequent launches.
  };

  /**
   * @brief Copy the process environment without exposing mutable host state.
   * @return Owned environment with Windows UTF-16 names and values converted to UTF-8.
   */
  boost::process::v1::environment current_environment();

  /** @brief Serialize HTTP launch/resume/stop and RTSP admission without holding the process state lock during media joins. @return Transition guard; acquire before registry or process locks. */
  std::unique_lock<std::mutex> lock_lifecycle();

  /** @brief Identity of one active execution, independent of mutable application configuration. */
  struct runtime_t {
    std::string app_id;  ///< Managed UUID, empty for an unmanaged application.
    std::string instance_id;  ///< Random execution identity; changes on every successful launch.
    int gamestream_id {0};  ///< Native application ID, zero when idle.
  };

  /**
   * @brief Tracks launched child processes and terminates them during shutdown.
   */
  class proc_t {
  public:
    /** @brief Construct an idle manager whose process ownership cannot be moved or copied. */
    proc_t() = default;

    /**
     * @brief Publish configuration for future launches without altering the running instance.
     * @param catalog Fully parsed application configuration.
     */
    void replace_catalog(catalog_t catalog);

    /**
     * @brief Launch the configured application process.
     *
     * @param app_id App ID.
     * @param launch_session Launch session.
     * @return Process exit code or launch error status.
     */
    int execute(int app_id, std::shared_ptr<rtsp_stream::launch_session_t> launch_session);

    /**
     * @return `_app_id` if a process is running, otherwise returns `0`
     */
    int running();

    /** @brief Read a coherent live identity, reaping an exited process if necessary. @return Active execution or an empty idle snapshot. */
    runtime_t runtime();

    /** @brief Stop only the named execution, never another application or a later launch. @param app_id Managed UUID. @param instance_id Expected execution identity. @return True only when the matching active execution was terminated. */
    bool terminate_if(const std::string &app_id, const std::string &instance_id);

    ~proc_t();

    /**
     * @brief Return the configured applications.
     *
     * @return Independent snapshot safe to retain across configuration updates.
     */
    std::vector<ctx_t> get_apps() const;
    /**
     * @brief Get app image.
     *
     * @param app_id App ID.
     * @return Validated image path for the requested application.
     */
    std::string get_app_image(int app_id);
    /**
     * @brief Get last run app name.
     *
     * @return Name of the most recently launched application.
     */
    std::string get_last_run_app_name();
    /**
     * @brief Terminate the launched application process.
     * @return True only after process termination is confirmed.
     */
    bool terminate();

    /**
     * @brief Read the capture identity of the current launch for transport resume.
     * @return The retained application identity, or null for explicit desktop scope.
     */
    capture::target_ptr capture_target() const {
      return _capture_target.get();
    }

    /**
     * @brief Inspect capture scope before display preparation or process launch.
     * @param app_id Configured application ID.
     * @return Active launch scope when running, otherwise the configured scope for the next launch.
     */
    bool uses_application_capture(int app_id) const;

  private:
    /** @brief Refresh process status with the state mutex held. @return Active native application ID or zero. */
    int running_locked();
    /** @brief Terminate the active launch while holding the state mutex. @return True after termination; failure retains process ownership for retry. */
    bool terminate_locked();

    mutable std::mutex _mutex;  ///< Serializes configuration publication and process lifecycle operations.
    catalog_t _catalog;  ///< Configuration for future launches; never owns a running process.
    int _app_id {0};
    std::string _instance_id;  ///< Non-reusable identity of the current execution.

    boost::process::v1::environment _env;  ///< Environment retained through the active launch's undo commands.
    ctx_t _app {};  ///< Immutable configuration snapshot of the most recent launch.
    capture::target_owner_t _capture_target;  ///< Identity retired before any process replacement.
    std::chrono::steady_clock::time_point _app_launch_time;

    // If no command associated with _app_id, yet it's still running
    bool placebo {};

    boost::process::v1::child _process;
    boost::process::v1::group _process_group;

    file_t _pipe;
    std::size_t _executed_prep_count {0};  ///< Completed prep commands whose undo remains pending.
  };

  /**
   * @brief Calculate a stable id based on name and image data
   * @return Tuple of id calculated without index (for use if no collision) and one with.
   *
   * @param app_name App name.
   * @param app_image_path App image path.
   * @param index Zero-based index of the item being addressed.
   */
  std::tuple<std::string, std::string> calculate_app_id(const std::string &app_name, std::string app_image_path, int index);

  /** @brief Validate an owned application's canonical lowercase UUID. @param id Application UUID. @return True for a non-nil canonical UUID. */
  bool valid_managed_id(std::string_view id);

  /** @brief Derive a positive GameStream ID independent of display name or icon. @param id Canonical application UUID. @return Stable decimal GameStream identifier. */
  std::string calculate_managed_app_id(std::string_view id);

  bool check_valid_png(const std::filesystem::path &path);
  /**
   * @brief Validate app image path.
   *
   * @param app_image_path Candidate image path from the application configuration.
   * @return Existing PNG path, or the default application image when validation fails.
   */
  std::string validate_app_image_path(std::string app_image_path);
  /**
   * @brief Refresh future launch configuration while preserving the active process and capture identity.
   *
   * @param file_name File name.
   */
  void refresh(const std::string &file_name);
  /**
   * @brief Parse serialized text into the corresponding runtime representation.
   *
   * @param file_name File name.
   * @return Parsed value or parse status.
   */
  std::optional<catalog_t> parse(const std::string &file_name);

  /** @brief Validate an unpublished catalog without touching its destination file. @param content Serialized application catalog. @return Parsed configuration, or null on invalid input. */
  std::optional<catalog_t> parse_content(std::string_view content);

  /**
   * @brief Initialize proc functions
   * @return Unique pointer to `deinit_t` to manage cleanup
   */
  std::unique_ptr<platf::deinit_t> init();

  /**
   * @brief Terminates all child processes in a process group.
   * @param proc The child process itself.
   * @param group The group of all children in the process tree.
   * @param exit_timeout The timeout to wait for the process group to gracefully exit.
   * @return An error if termination failed or remained unconfirmed; handles remain owned for retry.
   */
  std::error_code terminate_process_group(boost::process::v1::child &proc, boost::process::v1::group &group, std::chrono::seconds exit_timeout);

  extern proc_t proc;
}  // namespace proc
