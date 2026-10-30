/**
 * @file src/capture_target.h
 * @brief Immutable launch identity shared by application video and audio capture.
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>

namespace capture {
  /**
   * @brief A retained process identity; retirement never turns it into a desktop target.
   *
   * Implementations retain OS resources so an identifier recycled after process exit
   * cannot authorize capture from an unrelated process. Sessions keep the same object
   * across backend reinitialization and disconnect/resume.
   */
  class target_t {
  public:
    virtual ~target_t() = default;

    /**
     * @brief Read the original root process identifier used for process-tree audio.
     * @return Root PID protected by the retained OS identity.
     */
    virtual std::uint32_t process_id() const = 0;

    /**
     * @brief Check whether the launch still has live, owned processes.
     * @return False after retirement or when no owned process remains alive.
     */
    virtual bool alive() const = 0;

    /**
     * @brief Check membership of a currently live process in this launch.
     * @param process_id Candidate process identifier.
     * @return True only when OS membership can be verified.
     */
    virtual bool contains(std::uint32_t process_id) const = 0;

    /** @brief Permanently revoke capture before stopping or replacing this launch. */
    void retire() {
      retired_.store(true, std::memory_order_release);
    }

  protected:
    /**
     * @brief Check whether the owning launch has revoked this identity.
     * @return True after permanent retirement.
     */
    bool retired() const {
      return retired_.load(std::memory_order_acquire);
    }

  private:
    std::atomic_bool retired_ {false};  ///< Monotonic launch revocation flag.
  };

  /** @brief Shared launch identity retained independently of the process manager. */
  using target_ptr = std::shared_ptr<target_t>;

  /**
   * @brief Retain and validate the process resources from a successful launch.
   * @param process_id Root process identifier.
   * @param process_handle Borrowed native process handle.
   * @param group_handle Borrowed native process-group handle.
   * @return Owned identity, or null when this platform cannot bind the launch safely.
   */
  target_ptr bind_application(std::uint32_t process_id, std::uintptr_t process_handle, std::uintptr_t group_handle);
}  // namespace capture
