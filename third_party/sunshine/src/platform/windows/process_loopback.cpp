/**
 * @file src/platform/windows/process_loopback.cpp
 * @brief Bounded, lifetime-safe Windows process-loopback activation.
 */
#include "process_loopback.h"

#include <memory>
#include <mmdeviceapi.h>
#include <mutex>
#include <utility>

namespace platf::audio {
  namespace {
    /**
     * @brief Windows AUDIOCLIENT_ACTIVATION_PARAMS ABI for process-tree capture.
     *
     * MinGW does not expose audioclientactivationparams.h. These fixed-width fields
     * represent the documented Windows SDK ABI, rather than an endpoint fallback.
     * https://learn.microsoft.com/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params
     */
    struct process_activation_params_t {
      DWORD activation_type {1};  ///< AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK.
      DWORD process_id {0};  ///< Original root process ID.
      DWORD loopback_mode {0};  ///< PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE.
    };

    static_assert(sizeof(process_activation_params_t) == 12);

    /** @brief Shared completion state retained by both caller and asynchronous callback. */
    struct activation_state_t {
      HANDLE event {CreateEventW(nullptr, TRUE, FALSE, nullptr)};  ///< Completion signal owned until callback release.
      std::mutex mutex;  ///< Synchronizes completion data publication.
      HRESULT result {E_PENDING};  ///< Activation result, read only after completion.
      IAudioClient *client {nullptr};  ///< Owned activated client, transferred on success.
      capture::target_ptr target;  ///< Prevents PID reuse while activation remains pending.
      capture::renderer_ptr renderer;  ///< Keeps the rendering process alive independently of a bootstrap root.

      /** @brief Release callback-owned resources, including late completion after a timeout. */
      ~activation_state_t() {
        if (client) {
          client->Release();
        }
        if (event) {
          CloseHandle(event);
        }
      }
    };

    /** @brief Agile COM completion handler with independently retained state. */
    class activation_handler_t final: public IActivateAudioInterfaceCompletionHandler {
    public:
      /**
       * @brief Retain the shared activation state.
       * @param state Completion state shared with the waiting capture thread.
       */
      explicit activation_handler_t(std::shared_ptr<activation_state_t> state):
          state_(std::move(state)) {}

      /**
       * @brief Expose callback and agility marker interfaces.
       * @param iid Requested COM interface ID.
       * @param object Output interface pointer.
       * @return S_OK, E_POINTER or E_NOINTERFACE.
       */
      HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
        if (!object) {
          return E_POINTER;
        }
        *object = nullptr;
        if (iid == IID_IUnknown || iid == __uuidof(IActivateAudioInterfaceCompletionHandler) || iid == IID_IAgileObject) {
          *object = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
          AddRef();
          return S_OK;
        }
        return E_NOINTERFACE;
      }

      /** @brief Retain this callback. @return Updated reference count. */
      ULONG STDMETHODCALLTYPE AddRef() override {
        return ++references_;
      }

      /** @brief Release this callback. @return Updated reference count. */
      ULONG STDMETHODCALLTYPE Release() override {
        const auto remaining = --references_;
        if (!remaining) {
          delete this;
        }
        return remaining;
      }

      /**
       * @brief Publish the result; completion may arrive after the caller timed out.
       * @param operation Completed Windows activation operation.
       * @return S_OK after recording the activation result and signaling the waiter.
       */
      HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *operation) override {
        IUnknown *unknown = nullptr;
        HRESULT activated = E_FAIL;
        HRESULT result = operation->GetActivateResult(&activated, &unknown);
        IAudioClient *client = nullptr;
        if (SUCCEEDED(result)) {
          result = activated;
        }
        if (SUCCEEDED(result)) {
          result = unknown ? unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void **>(&client)) : E_POINTER;
        }
        if (unknown) {
          unknown->Release();
        }
        {
          std::lock_guard lock(state_->mutex);
          state_->result = result;
          state_->client = client;
        }
        SetEvent(state_->event);
        return S_OK;
      }

    private:
      std::atomic<ULONG> references_ {1};  ///< COM ownership across API and calling thread.
      std::shared_ptr<activation_state_t> state_;  ///< State kept alive until callback destruction.
    };
  }  // namespace

  HRESULT activate_process_loopback(const capture::target_ptr &target, IAudioClient **client, const capture::renderer_ptr &renderer) {
    if (!client) {
      return E_POINTER;
    }
    *client = nullptr;
    if (!target || !target->alive()) {
      return E_INVALIDARG;
    }
    const auto process_id = renderer ? renderer->process_id() : target->process_id();
    if ((renderer && !renderer->alive()) || !target->contains(process_id)) {
      return E_INVALIDARG;
    }

    auto state = std::make_shared<activation_state_t>();
    state->target = target;
    state->renderer = renderer;
    if (!state->event) {
      return HRESULT_FROM_WIN32(GetLastError());
    }
    process_activation_params_t parameters;
    parameters.process_id = process_id;
    PROPVARIANT variant {};
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(parameters);
    variant.blob.pBlobData = reinterpret_cast<BYTE *>(&parameters);

    auto handler = new activation_handler_t(state);
    IActivateAudioInterfaceAsyncOperation *operation = nullptr;
    const HRESULT started = ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &variant, handler, &operation);
    handler->Release();
    if (FAILED(started)) {
      if (operation) {
        operation->Release();
      }
      return started;
    }
    const DWORD wait = WaitForSingleObject(state->event, 5000);
    const DWORD wait_error = wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
    operation->Release();
    if (wait != WAIT_OBJECT_0) {
      return HRESULT_FROM_WIN32(wait_error);
    }
    std::lock_guard lock(state->mutex);
    if (FAILED(state->result)) {
      return state->result;
    }
    if (!target->alive() || (renderer && !renderer->alive())) {
      return HRESULT_FROM_WIN32(ERROR_PROCESS_ABORTED);
    }
    *client = std::exchange(state->client, nullptr);
    return S_OK;
  }
}  // namespace platf::audio
