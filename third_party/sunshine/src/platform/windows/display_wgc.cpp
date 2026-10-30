/**
 * @file src/platform/windows/display_wgc.cpp
 * @brief Definitions for WinRT Windows.Graphics.Capture API
 */
// platform includes
#include <dxgi1_2.h>

// local includes
#include "display.h"
#include "misc.h"
#include "src/logging.h"

// Gross hack to work around MINGW-packages#22160
#define ____FIReference_1_boolean_INTERFACE_DEFINED__

#include <Windows.Graphics.Capture.Interop.h>
#include <winrt/windows.foundation.h>
#include <winrt/windows.foundation.metadata.h>
#include <winrt/windows.graphics.directx.direct3d11.h>

namespace platf {
  using namespace std::literals;
}

namespace winrt {
  using namespace Windows::Foundation;
  using namespace Windows::Foundation::Metadata;
  using namespace Windows::Graphics::Capture;
  using namespace Windows::Graphics::DirectX::Direct3D11;

  extern "C" {
    /**
     * @brief Create direct3 D11 device from DXGI device.
     *
     * @param dxgiDevice DXGI device.
     * @param graphicsDevice Graphics device.
     * @return Created direct3 D11 device from DXGI device object or status.
     */
    HRESULT __stdcall CreateDirect3D11DeviceFromDXGIDevice(::IDXGIDevice *dxgiDevice, ::IInspectable **graphicsDevice);
  }

  /**
   * Windows structures sometimes have compile-time GUIDs. GCC supports this, but in a roundabout way.
   * If WINRT_IMPL_HAS_DECLSPEC_UUID is true, then the compiler supports adding this attribute to a struct. For example, Visual Studio.
   * If not, then MinGW GCC has a workaround to assign a GUID to a structure.
   */
  struct
#if WINRT_IMPL_HAS_DECLSPEC_UUID
    __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"))
#endif
    IDirect3DDxgiInterfaceAccess: ::IUnknown {
    /**
     * @brief Retrieve a DXGI interface from a WinRT Direct3D object.
     *
     * @param id COM interface ID requested from the WinRT wrapper.
     * @param object Output pointer that receives the requested COM interface.
     * @return HRESULT from the WinRT object's interface query.
     */
    virtual HRESULT __stdcall GetInterface(REFIID id, void **object) = 0;
  };
}  // namespace winrt
#if !WINRT_IMPL_HAS_DECLSPEC_UUID
static constexpr GUID GUID__IDirect3DDxgiInterfaceAccess = {
  0xA9B3D012,
  0x3DF2,
  0x4EE3,
  {0xB8, 0xD1, 0x86, 0x95, 0xF4, 0x57, 0xD3, 0xC1}
  // compare with __declspec(uuid(...)) for the struct above.
};

/**
 * @brief Return the GUID used to request IDirect3DDxgiInterfaceAccess.
 *
 * @return GUID for the WinRT DXGI interface-access helper.
 */
template<>
constexpr auto __mingw_uuidof<winrt::IDirect3DDxgiInterfaceAccess>() -> GUID const & {
  return GUID__IDirect3DDxgiInterfaceAccess;
}
#endif

namespace platf::dxgi {
  wgc_capture_t::wgc_capture_t() = default;

  wgc_capture_t::~wgc_capture_t() {
    frames->stopped.store(true, std::memory_order_release);
    WakeAllConditionVariable(&frames->ready);
    release_frame();
    try {
      if (capture_session) {
        capture_session.Close();
      }
    } catch (const winrt::hresult_error &) {
      // The OS may already have closed an application window's capture session.
    }
    try {
      if (frame_pool) {
        frame_pool.Close();
      }
    } catch (const winrt::hresult_error &) {
      // COM references below still release the closed frame pool.
    }
    item = nullptr;
    capture_session = nullptr;
    frame_pool = nullptr;
  }

  /**
   * @brief Initialize the Windows.Graphics.Capture backend.
   * @return 0 on success, -1 on failure.
   */
  int wgc_capture_t::init(display_base_t *display, const ::video::config_t &config) {
    HRESULT status = E_FAIL;
    application_target = config.capture_target;
    display->display_refresh_rate = {static_cast<UINT>(std::max(1, config.framerate)), 1};
    display->display_refresh_rate_rounded = std::max(1, config.framerate);
    dxgi::dxgi_t dxgi;
    winrt::com_ptr<::IInspectable> d3d_comhandle;
    try {
      if (!winrt::GraphicsCaptureSession::IsSupported()) {
        BOOST_LOG(error) << "Screen capture is not supported on this device for this release of Windows!"sv;
        return -1;
      }
      if (FAILED(status = display->device->QueryInterface(IID_IDXGIDevice, (void **) &dxgi))) {
        BOOST_LOG(error) << "Failed to query DXGI interface from device [0x"sv << util::hex(status).to_string_view() << ']';
        return -1;
      }
      if (FAILED(status = winrt::CreateDirect3D11DeviceFromDXGIDevice(*&dxgi, d3d_comhandle.put()))) {
        BOOST_LOG(error) << "Failed to query WinRT DirectX interface from device [0x"sv << util::hex(status).to_string_view() << ']';
        return -1;
      }
    } catch (winrt::hresult_error &e) {
      BOOST_LOG(error) << "Screen capture is not supported on this device for this release of Windows: failed to acquire device: [0x"sv << util::hex(e.code()).to_string_view() << ']';
      return -1;
    }

    DXGI_OUTPUT_DESC output_desc;
    uwp_device = d3d_comhandle.as<winrt::IDirect3DDevice>();
    display->output->GetDesc(&output_desc);

    try {
      auto factory = winrt::get_activation_factory<winrt::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
      if (application_target) {
        const auto deadline = std::chrono::steady_clock::now() + 5s;
        while (application_target->alive() && !(application_renderer = application_target->renderer()) && std::chrono::steady_clock::now() < deadline) {
          std::this_thread::sleep_for(50ms);
        }
        if (!application_renderer || !application_target->alive()) {
          BOOST_LOG(error) << "The application has no capturable window";
          return -1;
        }
        application_window = reinterpret_cast<HWND>(application_renderer->window_handle());
        status = factory->CreateForWindow(application_window, winrt::guid_of<winrt::IGraphicsCaptureItem>(), winrt::put_abi(item));
      } else {
        status = factory->CreateForMonitor(output_desc.Monitor, winrt::guid_of<winrt::IGraphicsCaptureItem>(), winrt::put_abi(item));
      }
      if (FAILED(status)) {
        BOOST_LOG(error) << "Failed to acquire the requested capture item [0x" << util::hex(status).to_string_view() << ']';
        return -1;
      }
      content_size = item.Size();
      item.Closed([closed = item_closed](auto const &, auto const &) {
        closed->store(true, std::memory_order_release);
      });
      if (application_target) {
        if (content_size.Width <= 0 || content_size.Height <= 0) {
          return -1;
        }
        display->width = display->width_before_rotation = content_size.Width;
        display->height = display->height_before_rotation = content_size.Height;
        display->display_rotation = DXGI_MODE_ROTATION_IDENTITY;
        RECT bounds {};
        if (FAILED(DwmGetWindowAttribute(application_window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)))) {
          if (!GetWindowRect(application_window, &bounds)) {
            return -1;
          }
        }
        display->offset_x = bounds.left - GetSystemMetrics(SM_XVIRTUALSCREEN);
        display->offset_y = bounds.top - GetSystemMetrics(SM_YVIRTUALSCREEN);
        BOOST_LOG(info) << "Application capture [" << application_target->process_id() << "] renderer [" << application_renderer->process_id() << "] " << display->width << 'x' << display->height;
      }
    } catch (const winrt::hresult_error &e) {
      BOOST_LOG(error) << "Failed to bind capture item [0x" << util::hex(e.code()).to_string_view() << ']';
      return -1;
    }

    if (config.dynamicRange) {
      display->capture_format = DXGI_FORMAT_R16G16B16A16_FLOAT;
    } else {
      display->capture_format = DXGI_FORMAT_B8G8R8A8_UNORM;
    }

    try {
      frame_pool = winrt::Direct3D11CaptureFramePool::CreateFreeThreaded(uwp_device, static_cast<winrt::Windows::Graphics::DirectX::DirectXPixelFormat>(display->capture_format), 2, item.Size());
      capture_session = frame_pool.CreateCaptureSession(item);
      frame_pool.FrameArrived([frames = frames](auto const &sender, auto const &) {
        on_frame_arrived(frames, sender);
      });
    } catch (winrt::hresult_error &e) {
      BOOST_LOG(error) << "Screen capture is not supported on this device for this release of Windows: failed to create capture session: [0x"sv << util::hex(e.code()).to_string_view() << ']';
      return -1;
    }
    try {
      if (winrt::ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        capture_session.IsBorderRequired(false);
      } else {
        BOOST_LOG(warning) << "Can't disable colored border around capture area on this version of Windows";
      }
    } catch (winrt::hresult_error &e) {
      BOOST_LOG(warning) << "Screen capture may not be fully supported on this device for this release of Windows: failed to disable border around capture area: [0x"sv << util::hex(e.code()).to_string_view() << ']';
    }
    try {
      if (winrt::ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval")) {
        capture_session.MinUpdateInterval(4ms);  // 250Hz
      } else {
        BOOST_LOG(warning) << "Can't set MinUpdateInterval on this version of Windows";
      }
    } catch (winrt::hresult_error &e) {
      BOOST_LOG(warning) << "Screen capture may be capped to 60fps on this device for this release of Windows: failed to set MinUpdateInterval: [0x"sv << util::hex(e.code()).to_string_view() << ']';
    }
    try {
      capture_session.StartCapture();
    } catch (winrt::hresult_error &e) {
      BOOST_LOG(error) << "Screen capture is not supported on this device for this release of Windows: failed to start capture: [0x"sv << util::hex(e.code()).to_string_view() << ']';
      return -1;
    }
    return 0;
  }

  /**
   * This function runs in a separate thread spawned by the frame pool and is a producer of frames.
   * To maintain parity with the original display interface, this frame will be consumed by the capture thread.
   * Acquire a read-write lock, make the produced frame available to the capture thread, then wake the capture thread.
   */
  void wgc_capture_t::on_frame_arrived(const std::shared_ptr<frame_state_t> &frames, winrt::Direct3D11CaptureFramePool const &sender) {
    if (frames->stopped.load(std::memory_order_acquire)) {
      return;
    }
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame frame {nullptr};
    try {
      frame = sender.TryGetNextFrame();
    } catch (winrt::hresult_error &e) {
      BOOST_LOG(warning) << "Failed to capture frame: "sv << e.code();
      return;
    }
    if (frame != nullptr) {
      AcquireSRWLockExclusive(&frames->lock);
      auto previous = std::move(frames->produced);
      frames->produced = std::move(frame);
      ReleaseSRWLockExclusive(&frames->lock);
      WakeConditionVariable(&frames->ready);
      if (previous) {
        try {
          previous.Close();
        } catch (const winrt::hresult_error &) {
          // Window closure can invalidate an outstanding frame.
        }
      }
    }
  }

  /**
   * @brief Get the next frame from the producer thread.
   * If not available, the capture thread blocks until one is, or the wait times out.
   */
  capture_e wgc_capture_t::next_frame(std::chrono::milliseconds timeout, ID3D11Texture2D **out, uint64_t &out_time) {
    // this CONSUMER runs in the capture thread
    release_frame();

    if (item_closed->load(std::memory_order_acquire)) {
      return application_target && application_target->alive() ? capture_e::reinit : capture_e::error;
    }
    if (application_target) {
      DWORD pid = 0;
      GetWindowThreadProcessId(application_window, &pid);
      if (!application_target->alive()) {
        return capture_e::error;
      }
      if (!application_target->contains(pid)) {
        return capture_e::reinit;
      }
      if (!application_renderer->alive()) {
        return capture_e::reinit;
      }
      if (IsIconic(application_window)) {
        std::this_thread::sleep_for(timeout);
        return capture_e::timeout;
      }
    }

    AcquireSRWLockExclusive(&frames->lock);
    if (frames->produced == nullptr && SleepConditionVariableSRW(&frames->ready, &frames->lock, timeout.count(), 0) == 0) {
      const auto wait_error = GetLastError();
      ReleaseSRWLockExclusive(&frames->lock);
      if (wait_error == ERROR_TIMEOUT) {
        return capture_e::timeout;
      } else {
        return capture_e::error;
      }
    }
    if (frames->produced) {
      consumed_frame = std::move(frames->produced);
    }
    ReleaseSRWLockExclusive(&frames->lock);
    if (consumed_frame == nullptr) {  // spurious wakeup
      return capture_e::timeout;
    }

    if (item_closed->load(std::memory_order_acquire) || (application_target && !application_target->alive())) {
      return capture_e::error;
    }
    try {
      const auto frame_size = consumed_frame.ContentSize();
      if (frame_size.Width != content_size.Width || frame_size.Height != content_size.Height) {
        return capture_e::reinit;
      }

      auto capture_access = consumed_frame.Surface().as<winrt::IDirect3DDxgiInterfaceAccess>();
      if (capture_access == nullptr) {
        return capture_e::error;
      }
      if (FAILED(capture_access->GetInterface(IID_ID3D11Texture2D, (void **) out))) {
        return capture_e::error;
      }
      out_time = consumed_frame.SystemRelativeTime().count();  // raw ticks from query performance counter
      return capture_e::ok;
    } catch (const winrt::hresult_error &) {
      return application_target && application_target->alive() ? capture_e::reinit : capture_e::error;
    }
  }

  capture_e wgc_capture_t::release_frame() {
    if (consumed_frame != nullptr) {
      try {
        consumed_frame.Close();
      } catch (const winrt::hresult_error &) {
        // Release the reference even when its source window already closed.
      }
      consumed_frame = nullptr;
    }
    return capture_e::ok;
  }

  int wgc_capture_t::set_cursor_visible(bool x) {
    try {
      if (capture_session.IsCursorCaptureEnabled() != x) {
        capture_session.IsCursorCaptureEnabled(x);
      }
      return 0;
    } catch (winrt::hresult_error &) {
      return -1;
    }
  }

  int display_wgc_ram_t::init(const ::video::config_t &config, const std::string &display_name) {
    if (display_base_t::init(config, display_name) || dup.init(this, config)) {
      return -1;
    }

    texture.reset();
    return 0;
  }

  /**
   * @brief Get the next frame from the Windows.Graphics.Capture API and copy it into a new snapshot texture.
   */
  capture_e display_wgc_ram_t::snapshot(const pull_free_image_cb_t &pull_free_image_cb, std::shared_ptr<platf::img_t> &img_out, std::chrono::milliseconds timeout, bool cursor_visible) {
    HRESULT status;
    texture2d_t src;
    uint64_t frame_qpc;
    dup.set_cursor_visible(cursor_visible);
    auto capture_status = dup.next_frame(timeout, &src, frame_qpc);
    if (capture_status != capture_e::ok) {
      return capture_status;
    }

    auto frame_timestamp = std::chrono::steady_clock::now() - qpc_time_difference(qpc_counter(), frame_qpc);
    D3D11_TEXTURE2D_DESC desc;
    src->GetDesc(&desc);

    // Create the staging texture if it doesn't exist. It should match the source in size and format.
    if (texture == nullptr) {
      capture_format = desc.Format;
      BOOST_LOG(info) << "Capture format ["sv << dxgi_format_to_string(capture_format) << ']';

      D3D11_TEXTURE2D_DESC t {};
      t.Width = width;
      t.Height = height;
      t.MipLevels = 1;
      t.ArraySize = 1;
      t.SampleDesc.Count = 1;
      t.Usage = D3D11_USAGE_STAGING;
      t.Format = capture_format;
      t.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

      auto status = device->CreateTexture2D(&t, nullptr, &texture);

      if (FAILED(status)) {
        BOOST_LOG(error) << "Failed to create staging texture [0x"sv << util::hex(status).to_string_view() << ']';
        return capture_e::error;
      }
    }

    // It's possible for our display enumeration to race with mode changes and result in
    // mismatched image pool and desktop texture sizes. If this happens, just reinit again.
    if (desc.Width != width || desc.Height != height) {
      BOOST_LOG(info) << "Capture size changed ["sv << width << 'x' << height << " -> "sv << desc.Width << 'x' << desc.Height << ']';
      return capture_e::reinit;
    }
    // It's also possible for the capture format to change on the fly. If that happens,
    // reinitialize capture to try format detection again and create new images.
    if (capture_format != desc.Format) {
      BOOST_LOG(info) << "Capture format changed ["sv << dxgi_format_to_string(capture_format) << " -> "sv << dxgi_format_to_string(desc.Format) << ']';
      return capture_e::reinit;
    }

    // Copy from GPU to CPU
    device_ctx->CopyResource(texture.get(), src.get());

    if (!pull_free_image_cb(img_out)) {
      return capture_e::interrupted;
    }
    auto img = (img_t *) img_out.get();

    // Map the staging texture for CPU access (making it inaccessible for the GPU)
    if (FAILED(status = device_ctx->Map(texture.get(), 0, D3D11_MAP_READ, 0, &img_info))) {
      BOOST_LOG(error) << "Failed to map texture [0x"sv << util::hex(status).to_string_view() << ']';

      return capture_e::error;
    }

    // Now that we know the capture format, we can finish creating the image
    if (complete_img(img, false)) {
      device_ctx->Unmap(texture.get(), 0);
      img_info.pData = nullptr;
      return capture_e::error;
    }

    std::copy_n((std::uint8_t *) img_info.pData, height * img_info.RowPitch, (std::uint8_t *) img->data);

    // Unmap the staging texture to allow GPU access again
    device_ctx->Unmap(texture.get(), 0);
    img_info.pData = nullptr;

    if (img) {
      img->frame_timestamp = frame_timestamp;
    }

    return capture_e::ok;
  }

  capture_e display_wgc_ram_t::release_snapshot() {
    return dup.release_frame();
  }
}  // namespace platf::dxgi
