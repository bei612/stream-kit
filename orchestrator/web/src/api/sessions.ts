export interface SessionAudio {
  program_gain_db: number
  microphone_gain_db: number
  microphone_enabled: boolean
  broadcast_controller_microphone: boolean
  controller_monitor: boolean
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
}
