export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key:string]: ConfigValue }
export interface ConfigurationView {
  revision:string
  restart_required:boolean
  apply_policy:'service_restart'
  values:Record<string,ConfigValue>
  redacted_paths:string[]
  environment_overrides:string[]
}

export interface GatewayConfigurationView {
  revision:string
  running_revision?:string|null
  restart_required:boolean
  apply_policy:'gateway_restart'
  values:Record<string,ConfigValue>
  redacted_paths:string[]
  overridden_paths:string[]
}
