/**
 * @file src/platform/windows/process_loopback.h
 * @brief Activate WASAPI capture for one retained application process tree.
 */
#pragma once

#include "src/capture_target.h"

#include <audioclient.h>

namespace platf::audio {
  /**
   * @brief Activate a process-tree loopback client without selecting or changing an endpoint.
   * @param target Retained application launch identity.
   * @param client Receives one owned COM reference on success; null on failure.
   * @param renderer Selected rendering process; empty only when explicitly capturing the live launch root.
   * @return Activation HRESULT, including timeout or target retirement failures.
   */
  HRESULT activate_process_loopback(const capture::target_ptr &target, IAudioClient **client, const capture::renderer_ptr &renderer = {});
}  // namespace platf::audio
