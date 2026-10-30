export interface SessionAudio {
  target: AudioTarget
  program_gain_db: number
  microphone_gain_db: number
  microphone_enabled: boolean
  broadcast_controller_microphone: boolean
  controller_monitor: boolean
}

export interface AudioTarget {
  epoch: number
  mode: 'disabled' | 'upstream' | 'local'
  render_device_id: string
  capture_device_id: string
}

export interface SessionPolicy {
  controller_disconnect_policy: 'release' | 'manual'
  max_viewers: number
  allow_viewer_microphone: boolean
}

export interface SessionConnection {
  connection_id: string
  user_id?: string
  role: 'viewer' | 'controller'
  state: string
  microphone: boolean
  microphone_live: boolean
  connected_at: string
  last_heartbeat_at: string
  expires_at: string
}

export interface RenderSession {
  control_epoch: number
  session_id: string
  revision: number
  host_id: number
  app_id: number
  state: 'starting' | 'running' | 'degraded' | 'stopping' | 'stopped'
  controller_connection_id?: string
  connections: Record<string, SessionConnection>
  audio: SessionAudio
  policy: SessionPolicy
  created_at: string
  updated_at: string
}

export interface MediaControlStatus {
  reachable: boolean
  lease_valid: boolean
  acknowledged_at_ms: number
  lease_expires_at_ms: number
  applied_revisions: Record<string, number>
  observed_at_ms: number
  observations_valid: boolean
  observations_expires_at_ms: number
  observations: Record<string, MediaObservation>
}

export interface TargetDeviceStatus {
  device_open: boolean
  device_sample_frames: number
  dropped_frames: number
  xruns: number
  realtime_denied: boolean
  error: string | null
}

export interface MediaObservation {
  session_id: string
  revision: number
  upstream_active: boolean
  subscribers: number
  microphone_target: {
    epoch: number
    state: 'unconfigured' | 'idle' | 'pending' | 'disabled' | 'device_open' | 'device_failed' | 'upstream_transport'
    device: TargetDeviceStatus | null
    error: string | null
  }
}

// A saved policy, an acknowledged revision and an observed device are separate
// facts. Never render stale runtime telemetry as evidence of current delivery.
export function currentMediaObservation(status: MediaControlStatus | null | undefined, session: Pick<RenderSession, 'session_id' | 'revision'>, now = Date.now()): MediaObservation | undefined {
  if (!status?.reachable || !status.lease_valid || !status.observations_valid ||
    now >= status.lease_expires_at_ms || now < status.acknowledged_at_ms || !(now < status.observations_expires_at_ms)) return undefined
  const observed = status.observations?.[session.session_id]
  return observed?.session_id === session.session_id && observed.revision === session.revision ? observed : undefined
}
