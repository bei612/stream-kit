import type { TargetDeviceStatus } from './sessions'

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
  schema_version: 2
  instance_id: string
  request_id: string
  request_issued_at_ms: number
  observed_at_ms: number
  devices: AudioDevice[]
  configured_routes: AudioRoute[]
}

export interface AudioPairMeasurement {
  captured_frames: number
  tone_amplitude: number
  quiet: boolean
  rms: number
  peak: number
}

export interface AudioPairCheckResult {
  passed: boolean
  captured_frames: number
  tone_amplitude: number
  tone: AudioPairMeasurement | null
  first_error_after_frames: number | null
  submitted_packets: number
  closed_after_drop: boolean
  baseline: AudioPairMeasurement
  after_clear: AudioPairMeasurement
  target: TargetDeviceStatus
  drain_before_silence_ms: number
}
