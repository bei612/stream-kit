import { API_BASE, getToken, clearToken } from '@/lib/utils'
import type { RenderSession, SessionAudio, SessionPolicy, MediaControlStatus, AudioTarget, StreamSessionOverview, TimedStreamSessionOverview } from './sessions'
import type { AudioInventory, AudioPairCheckResult } from './audio-devices'
import type { ConfigurationView, GatewayConfigurationView, EncoderConfigurationView, EncoderConfigurationAcknowledgement, EncoderStartupState, ConfigValue } from './configuration'
import type { ApplicationRecord, ApplicationView, ApplicationUpdate, ExecutableCandidate, ArchiveUpload, ComponentInfo, HealthStatus, OperationLog, SanitizedConfiguration } from './management'
import { decodeApiResponse, type ApiResponse } from './response'

function expiredLoginError(): Error {
  clearToken()
  window.dispatchEvent(new CustomEvent('auth-error'))
  return new Error('登录已过期，请重新登录')
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
    ...((options.headers as Record<string, string>) || {}),
  }

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const controller = new AbortController()
  const callerAbort = () => controller.abort()
  options.signal?.addEventListener('abort', callerAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(url, { ...options, headers, signal: controller.signal })

    if (resp.status === 401) {
      throw expiredLoginError()
    }

    let body: unknown
    try {
      body = await resp.json()
    } catch {
      throw new Error(`服务器返回了非 JSON 响应 (HTTP ${resp.status})`)
    }
    const json = decodeApiResponse<T>(body)
    if (!resp.ok || json.status === 'error') {
      throw new Error(json.message || `请求失败 (${resp.status})`)
    }
    return json
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      if (options.signal?.aborted) throw e
      throw new Error('请求超时，请检查服务器状态')
    }
    throw e
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', callerAbort)
  }
}

// Login doesn't need auth token
async function loginRequest(username: string, password: string): Promise<{ token: string; expires_at: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const resp = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
    let body: unknown
    try {
      body = await resp.json()
    } catch {
      throw new Error('服务器响应异常')
    }
    const json = decodeApiResponse<{ token: string; expires_at: string }>(body)
    if (!resp.ok || json.status === 'error') {
      throw new Error(json.message || '登录失败')
    }
    if (!json.data || typeof json.data.token !== 'string' || !json.data.token || typeof json.data.expires_at !== 'string' || !Number.isFinite(Date.parse(json.data.expires_at))) throw new Error('登录响应缺少有效凭据')
    return json.data
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('连接超时，请检查服务器是否运行')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  watchLink: (id: string, method = 'GET') => request<{ enabled: boolean; path: string }>(`/apps/${id}/watch-link`, { method }),
  getEncoderConfiguration: () => request<EncoderConfigurationView>('/encoder-configuration'),
  applyEncoderConfiguration: (revision:string, instance_id:string) => request<EncoderStartupState>('/encoder-configuration/apply', {method:'POST',body:JSON.stringify({revision,instance_id})}, 90000),
  saveEncoderConfiguration: (revision:string, changes:Record<string,ConfigValue>) => request<EncoderConfigurationAcknowledgement>('/encoder-configuration', {method:'PATCH',body:JSON.stringify({revision,changes})}),
  // Auth
  login: loginRequest,

  // Health
  health: (signal?: AbortSignal) => request<HealthStatus>('/health', { signal }),

  // Components
  listComponents: (signal?: AbortSignal) => request<ComponentInfo[]>('/components', { signal }),
  getComponent: (name: string) => request<ComponentInfo>(`/components/${name}`),
  startComponent: (name: string) => request<ComponentInfo>(`/components/${name}/start`, { method: 'POST' }),
  stopComponent: (name: string) => request<ComponentInfo>(`/components/${name}/stop`, { method: 'POST' }),
  restartComponent: (name: string) => request<ComponentInfo>(`/components/${name}/restart`, { method: 'POST' }),
  getComponentLogs: (name: string, lines = 100) =>
    request<string[]>(`/components/${name}/logs?lines=${lines}`),
  startAllComponents: () => request<ComponentInfo[]>('/components/start-all', { method: 'POST' }),
  stopAllComponents: () => request<ComponentInfo[]>('/components/stop-all', { method: 'POST' }),

  // Shared stream sessions
  inviteStreamViewers: (hostId: number, appId: number) =>
    request<{ invitation: string; expires_at: string; gateway_public_url: string }>('/stream-invitations', {
      method: 'POST', body: JSON.stringify({ host_id: hostId, app_id: appId }),
    }),
  listStreamSessions: () => request<RenderSession[]>('/stream-sessions'),
  getStreamSession: (id: string) => request<RenderSession>(`/stream-sessions/${id}`),
  getMediaControl: () => request<MediaControlStatus>('/media-control'),
  getStreamSessionOverview: async (signal?: AbortSignal): Promise<ApiResponse<TimedStreamSessionOverview>> => {
    const request_started_at_ms = Date.now()
    const request_started_monotonic_ms = performance.now()
    const response = await request<StreamSessionOverview>('/stream-sessions/overview', { signal })
    return { ...response, data: response.data ? { ...response.data, request_started_at_ms, request_started_monotonic_ms } : undefined }
  },
  getAudioDevices: () => request<AudioInventory>('/audio-devices'),
  getRenderNodes: () => request<{apply_policy:string,nodes:{id:string,name:string,base_url:string}[]}>('/render-nodes'),
  getNodeAudioDevices: (id:string) => request<{node_id:string,inventory:AudioInventory}>(`/render-nodes/${encodeURIComponent(id)}/audio-devices`),
  checkAudioPair: (render_device_id: string, capture_device_id: string) => request<AudioPairCheckResult>('/audio-devices/check-pair', { method: 'POST', body: JSON.stringify({render_device_id, capture_device_id}) }),
  updateAudioTarget: (id: string, expectedEpoch: number, target: Omit<AudioTarget, 'epoch'>) =>
    request<RenderSession>(`/stream-sessions/${id}/audio-target`, { method:'PATCH', body:JSON.stringify({expected_epoch:expectedEpoch,target}) }),
  transferStreamController: (sessionId: string, connectionId: string, expectedControllerId: string, expectedControlEpoch: number) =>
    request<RenderSession>(`/stream-sessions/${sessionId}/controller/${connectionId}`, {
      method: 'PUT', body: JSON.stringify({ expected_controller_connection_id: expectedControllerId, expected_control_epoch: expectedControlEpoch }),
    }),
  updateStreamAudio: (sessionId: string, audio: SessionAudio, expected: SessionAudio) =>
    request<RenderSession>(`/stream-sessions/${sessionId}/audio`, { method: 'PATCH', body: JSON.stringify({...audio, expected_audio: expected}) }),
  updateStreamPolicy: (sessionId: string, policy: SessionPolicy, expected: SessionPolicy) =>
    request<RenderSession>(`/stream-sessions/${sessionId}/policy`, { method: 'PATCH', body: JSON.stringify({...policy, expected_policy: expected}) }),
  claimStreamController: (sessionId: string, connectionId: string) =>
    request<RenderSession>(`/stream-sessions/${sessionId}/controller/${connectionId}`, { method: 'POST' }),
  releaseStreamController: (sessionId: string) =>
    request<RenderSession>(`/stream-sessions/${sessionId}/controller`, { method: 'DELETE' }),
  disconnectStreamConnection: (sessionId: string, connectionId: string) =>
    request<{ removed: boolean }>(`/stream-sessions/${sessionId}/connections/${connectionId}`, { method: 'DELETE' }),
  issueStreamMediaTicket: (sessionId: string, connectionId: string) =>
    request<{ ticket: string; expires_at: string; role: 'viewer' | 'controller' }>(`/stream-sessions/${sessionId}/connections/${connectionId}/ticket`, { method: 'POST' }),

  // Apps
  captureCapabilities: () => request<{schema_version:number; capture_modes:('desktop'|'application')[]; capture_mode_apply:'application_restart'}>('/apps/capture-capabilities'),
  registerLocalApp: (data: { name:string; exe_path:string; working_dir:string; args:string; args_template:string; capture_mode:'desktop'|'application' }) =>
    request<{id:string}>('/apps/local', { method:'POST', body:JSON.stringify(data) }),
  listApps: (signal?: AbortSignal) => request<ApplicationView[]>('/apps', { signal }),
  getApp: (id: string, signal?: AbortSignal) => request<ApplicationView>(`/apps/${id}`, { signal }),
  updateApp: (id: string, data: ApplicationUpdate) =>
    request<ApplicationRecord>(`/apps/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteApp: (id: string) => request<{ message: string }>(`/apps/${id}?confirm=true`, { method: 'DELETE' }),
  getAppCandidates: (id: string, signal?: AbortSignal) => request<ExecutableCandidate[] | null>(`/apps/${id}/candidates`, { signal }),
  selectExe: (id: string, exePath: string) =>
    request<ApplicationRecord>(`/apps/${id}/exe`, { method: 'PUT', body: JSON.stringify({ exe_path: exePath }) }),
  retryRegister: (id: string) => request<{ message: string }>(`/apps/${id}/register`, { method: 'POST' }),
  uploadStatus: () => request<{ uploading: boolean }>('/apps/upload-status'),
  launchApp: (id: string) => request<{ stream_url: string }>(`/apps/${id}/launch`, { method: 'POST' }, 60000),
  stopApp: (id: string) => request<ApplicationRecord>(`/apps/${id}/stop`, { method: 'POST' }),
  getAppStatus: (id: string) => request<Pick<ApplicationRecord, 'status'>>(`/apps/${id}/status`),
  getAppLogs: (id: string, lines = 200) => request<{ app_id: string; lines: string[] }>(`/apps/${id}/logs?lines=${lines}`),

  // Upload — returns { promise, abort } for cancellation support
  uploadApp: (formData: FormData, onProgress?: (pct: number) => void) => {
    const xhr = new XMLHttpRequest()
    const promise = new Promise<ApiResponse<ArchiveUpload>>((resolve, reject) => {
      xhr.open('POST', `${API_BASE}/apps/upload`)
      xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`)
      xhr.timeout = 30 * 60 * 1000 // 30 minutes for large packages

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress((e.loaded / e.total) * 100)
        }
      }

      xhr.ontimeout = () => reject(new Error('上传超时，请检查网络连接'))
      xhr.onabort = () => reject(new Error('上传已取消'))
      xhr.onerror = () => reject(new Error('网络错误'))
      xhr.onload = () => {
        if (xhr.status === 401) {
          reject(expiredLoginError())
          return
        }
        try {
          const json = decodeApiResponse<ArchiveUpload>(JSON.parse(xhr.responseText))
          if (xhr.status < 200 || xhr.status >= 300 || json.status === 'error') {
            reject(new Error(json.message || '上传失败'))
          } else {
            resolve(json)
          }
        } catch {
          reject(new Error('上传响应解析失败'))
        }
      }
      xhr.send(formData)
    })
    return { promise, abort: () => xhr.abort() }
  },

  // System
  getConfig: () => request<SanitizedConfiguration>('/config'),
  getConfiguration: () => request<ConfigurationView>('/configuration'),
  getGatewayConfiguration: () => request<GatewayConfigurationView>('/gateway-configuration'),
  saveGatewayConfiguration: (revision:string, changes:Record<string,ConfigValue>) => request<GatewayConfigurationView>('/gateway-configuration', {method:'PATCH',body:JSON.stringify({revision,changes})}),
  applyGatewayConfiguration: (revision:string, instance_id:string) => request<GatewayConfigurationView>('/gateway-configuration/apply', {method:'POST',body:JSON.stringify({revision,instance_id})},100000),
  saveConfiguration: (revision:string, changes:Record<string,ConfigValue>) => request<ConfigurationView>('/configuration', {method:'PATCH',body:JSON.stringify({revision,changes})}),
  getTemplates: () => request<Record<string, string>>('/templates'),
  getLogs: async (params: { page?: number; size?: number; target_type?: string }, signal?: AbortSignal) => {
    const qs = new URLSearchParams()
    if (params.page) qs.set('page', String(params.page))
    if (params.size) qs.set('size', String(params.size))
    if (params.target_type) qs.set('target_type', params.target_type)
    const response = await request<OperationLog[]>(`/logs?${qs}`, { signal })
    if (!response.pagination) throw new Error('服务器未返回日志分页信息')
    return response
  },
}
