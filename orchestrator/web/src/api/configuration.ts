export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key:string]: ConfigValue }
export interface ConfigurationView {
  revision:string
  restart_required:boolean
  apply_policy:'service_restart'
  values:Record<string,ConfigValue>
  redacted_paths:string[]
  environment_overrides:string[]
}
