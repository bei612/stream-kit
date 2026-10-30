/**
 * @file src/capture_target.h
 * @brief Immutable launch identity shared by application video and audio capture.
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>

namespace capture {
  /** @brief Retained renderer selected once for both picture and process-tree sound. */
  class renderer_t {
  public:
    virtual ~renderer_t() = default;
    /** @brief Read the retained rendering process. @return PID protected from reuse. */
    virtual std::uint32_t process_id() const = 0;
    /** @brief Read the native window identity. @return Platform window handle. */
    virtual std::uintptr_t window_handle() const = 0;
    /** @brief Verify the selected process and window still exist. @return True while both remain valid. */
    virtual bool alive() const = 0;
  };

  using renderer_ptr = std::shared_ptr<renderer_t>;  ///< Renderer snapshot shared across capture backends.

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
     * @brief Read the original launch root process identifier.
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

    /**
     * @brief Select or reuse the live rendering window within this launch's owned processes.
     * @return Retained renderer, or null while no eligible window exists.
     * @note A renderer is replaced only after its window or process becomes invalid.
     */
    virtual renderer_ptr renderer() const = 0;

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

  /** @brief Movable launch ownership that atomically publishes identities and retires replaced targets. */
  class target_owner_t {
  public:
    target_owner_t() = default;

    /** @brief Retire the identity before releasing launch ownership. */
    ~target_owner_t() {
      replace({});
    }

    /**
     * @brief Transfer launch ownership without retiring the transferred identity.
     * @param other Previous launch owner.
     */
    target_owner_t(target_owner_t &&other) noexcept:
        target_(other.target_.exchange({})) {}

    /**
     * @brief Retire this owner's old identity and transfer another launch.
     * @param other Previous owner of the incoming launch.
     * @return This owner after transfer.
     */
    target_owner_t &operator=(target_owner_t &&other) noexcept {
      if (this != &other) {
        replace(other.target_.exchange({}));
      }
      return *this;
    }

    /** @brief Read the current launch identity. @return A retained snapshot safe across replacement. */
    target_ptr get() const {
      return target_.load();
    }

    /**
     * @brief Publish an identity and permanently revoke the previous launch.
     * @param target Incoming identity, or null when the launch ends.
     */
    void replace(target_ptr target) {
      auto previous = target_.exchange(target);
      if (previous && previous != target) {
        previous->retire();
      }
    }

  private:
    std::atomic<target_ptr> target_;  ///< Identity observed by concurrent transport resume requests.
  };

  /**
   * @brief Retain and validate the process resources from a successful launch.
   * @param process_id Root process identifier.
   * @param process_handle Borrowed native process handle.
   * @param group_handle Borrowed native process-group handle.
   * @return Owned identity, or null when this platform cannot bind the launch safely.
   */
  target_ptr bind_application(std::uint32_t process_id, std::uintptr_t process_handle, std::uintptr_t group_handle);
}  // namespace capture
