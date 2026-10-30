export interface AudioDevice {
  id: string
  name: string
  input: boolean
  output: boolean
}

export interface AudioRoute {
  host_id: number
  app_id: number
  endpoint: { render_device_id: string; capture_device_id: string }
}

export interface AudioInventory {
  schema_version: 1
  request_id: string
  request_issued_at_ms: number
  observed_at_ms: number
  devices: AudioDevice[]
  configured_routes: AudioRoute[]
}
