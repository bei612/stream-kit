import { API_BASE, getToken, clearToken } from '@/lib/utils'
import type { RenderSession, SessionAudio, SessionPolicy, MediaControlStatus, AudioTarget } from './sessions'
import type { AudioInventory } from './audio-devices'
import type { ConfigurationView, GatewayConfigurationView, EncoderConfigurationView, EncoderConfigurationAcknowledgement, EncoderStartupState, ConfigValue } from './configuration'

interface ApiResponse<T = unknown> {
  status: 'ok' | 'error'
  data?: T
  code?: string
  message?: string
  request_id?: string
  pagination?: { page: number; size: number; total: number }
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
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(url, { ...options, headers, signal: controller.signal })

    if (resp.status === 401) {
      clearToken()
      window.dispatchEvent(new CustomEvent('auth-error'))
      throw new Error('登录已过期，请重新登录')
    }

    let json: any
    try {
      json = await resp.json()
    } catch {
      throw new Error(`服务器返回了非 JSON 响应 (HTTP ${resp.status})`)
    }
    if (!resp.ok || json.status === 'error') {
      throw new Error(json.message || `请求失败 (${resp.status})`)
    }
    return json
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('请求超时，请检查服务器状态')
    }
    throw e
  } finally {
    clearTimeout(timer)
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
    let json: any
    try {
      json = await resp.json()
    } catch {
      throw new Error('服务器响应异常')
    }
    if (!resp.ok || json.status === 'error') {
      throw new Error(json.message || '登录失败')
    }
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
  getEncoderConfiguration: () => request<EncoderConfigurationView>('/encoder-configuration'),
  applyEncoderConfiguration: (revision:string, instance_id:string) => request<EncoderStartupState>('/encoder-configuration/apply', {method:'POST',body:JSON.stringify({revision,instance_id})}, 90000),
  saveEncoderConfiguration: (revision:string, changes:Record<string,ConfigValue>) => request<EncoderConfigurationAcknowledgement>('/encoder-configuration', {method:'PATCH',body:JSON.stringify({revision,changes})}),
  // Auth
  login: loginRequest,

  // Health
  health: () => request<any>('/health'),

  // Components
  listComponents: () => request<any[]>('/components'),
  getComponent: (name: string) => request<any>(`/components/${name}`),
  startComponent: (name: string) => request<any>(`/components/${name}/start`, { method: 'POST' }),
  stopComponent: (name: string) => request<any>(`/components/${name}/stop`, { method: 'POST' }),
  restartComponent: (name: string) => request<any>(`/components/${name}/restart`, { method: 'POST' }),
  getComponentLogs: (name: string, lines = 100) =>
    request<string[]>(`/components/${name}/logs?lines=${lines}`),
  startAllComponents: () => request<any>('/components/start-all', { method: 'POST' }),
  stopAllComponents: () => request<any>('/components/stop-all', { method: 'POST' }),

  // Shared stream sessions
  inviteStreamViewers: (hostId: number, appId: number) =>
    request<{ invitation: string; expires_at: string; gateway_public_url: string }>('/stream-invitations', {
      method: 'POST', body: JSON.stringify({ host_id: hostId, app_id: appId }),
    }),
  listStreamSessions: () => request<RenderSession[]>('/stream-sessions'),
  getStreamSession: (id: string) => request<RenderSession>(`/stream-sessions/${id}`),
  getMediaControl: () => request<MediaControlStatus>('/media-control'),
  getAudioDevices: () => request<AudioInventory>('/audio-devices'),
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
  listApps: () => request<any[]>('/apps'),
  getApp: (id: string) => request<any>(`/apps/${id}`),
  updateApp: (id: string, data: any) =>
    request<any>(`/apps/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteApp: (id: string) => request<any>(`/apps/${id}?confirm=true`, { method: 'DELETE' }),
  getAppCandidates: (id: string) => request<any[]>(`/apps/${id}/candidates`),
  selectExe: (id: string, exePath: string) =>
    request<any>(`/apps/${id}/exe`, { method: 'PUT', body: JSON.stringify({ exe_path: exePath }) }),
  retryRegister: (id: string) => request<any>(`/apps/${id}/register`, { method: 'POST' }),
  uploadStatus: () => request<any>('/apps/upload-status'),
  launchApp: (id: string) => request<any>(`/apps/${id}/launch`, { method: 'POST' }),
  stopApp: (id: string) => request<any>(`/apps/${id}/stop`, { method: 'POST' }),
  getAppStatus: (id: string) => request<any>(`/apps/${id}/status`),
  getAppLogs: (id: string, lines = 200) => request<any>(`/apps/${id}/logs?lines=${lines}`),

  // Upload — returns { promise, abort } for cancellation support
  uploadApp: (formData: FormData, onProgress?: (pct: number) => void) => {
    const xhr = new XMLHttpRequest()
    const promise = new Promise<ApiResponse>((resolve, reject) => {
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
        try {
          const json = JSON.parse(xhr.responseText)
          if (xhr.status >= 400 || json.status === 'error') {
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
  getConfig: () => request<any>('/config'),
  getConfiguration: () => request<ConfigurationView>('/configuration'),
  getGatewayConfiguration: () => request<GatewayConfigurationView>('/gateway-configuration'),
  saveGatewayConfiguration: (revision:string, changes:Record<string,ConfigValue>) => request<GatewayConfigurationView>('/gateway-configuration', {method:'PATCH',body:JSON.stringify({revision,changes})}),
  applyGatewayConfiguration: (revision:string, instance_id:string) => request<GatewayConfigurationView>('/gateway-configuration/apply', {method:'POST',body:JSON.stringify({revision,instance_id})},100000),
  saveConfiguration: (revision:string, changes:Record<string,ConfigValue>) => request<ConfigurationView>('/configuration', {method:'PATCH',body:JSON.stringify({revision,changes})}),
  getTemplates: () => request<Record<string, string>>('/templates'),
  getLogs: (params: { page?: number; size?: number; target_type?: string }) => {
    const qs = new URLSearchParams()
    if (params.page) qs.set('page', String(params.page))
    if (params.size) qs.set('size', String(params.size))
    if (params.target_type) qs.set('target_type', params.target_type)
    return request<any[]>(`/logs?${qs}`)
  },
}
