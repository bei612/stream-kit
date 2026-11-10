import type { ConfigValue } from './configuration'

// Management projections mirror the Go producers. A stored application and its
// lifecycle view are distinct: command responses do not add lifecycle grants.
export type ApplicationStatus = 'uploading' | 'extracting' | 'detecting' | 'registering' | 'register_failed' | 'ready' | 'running' | 'stopped' | 'crashed' | 'error'
export interface ApplicationRecord {
  id: string
  name: string
  status: ApplicationStatus
  source: 'archive' | 'local'
  capture_mode: 'desktop' | 'application'
  exe_path: string
  exe_relative_path: string
  args: string
  args_template: string | null
  app_dir: string
  working_dir: string
  sunshine_app_name: string
  sunshine_app_id: number
  file_size_bytes: number
  extracted_size_bytes: number
  stream_url: string
  error_message: string
  created_at: string
  updated_at: string
}
export interface ApplicationView extends ApplicationRecord {
  lifecycle: { session_state: string; can_launch: boolean; can_stop: boolean; can_edit: boolean }
}
export interface ApplicationUpdate {
  name?: string
  args?: string
  args_template?: string
  capture_mode?: ApplicationRecord['capture_mode']
}
export interface ExecutableCandidate { relative_path: string; full_path: string; size_bytes: number }
export interface ArchiveUpload { app_id: string; name: string; message: string }
export type ComponentStatus = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'crashed' | 'error'
export interface ComponentInfo {
  name: string
  status: ComponentStatus
  pid: number
  started_at?: string
  crash_count: number
  last_error?: string
}
export interface HealthStatus {
  version: string
  commit: string
  build_time: string
  components?: Record<string, Pick<ComponentInfo, 'status' | 'pid' | 'crash_count'>>
  apps_summary?: { total: number; running: number; ready: number; error: number }
}
export interface OperationLog {
  id: number
  target_type: string
  target_id: string
  operation: string
  result: string
  message: string
  detail: string
  created_at: string
}
export type SanitizedConfiguration = Record<string, ConfigValue>
