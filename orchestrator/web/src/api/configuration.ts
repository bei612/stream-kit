export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key:string]: ConfigValue }
export interface EncoderConfigurationAcknowledgement {
  revision:string
  apply_policy:'encoder_restart'
  runtime_verified:false
}
export interface EncoderStartupState {
  revision:string
  loaded_revision:string
  instance_id:string
  process_id:number
  managed_instance_id?:string
  restart_required:boolean
  overridden_keys:string[]
}
export interface EncoderConfigurationView extends EncoderConfigurationAcknowledgement {
  fields?:{key:string;label:string;description?:string;type:'string'|'boolean'|'integer'|'number';minimum?:number;maximum?:number;choices?:string[]}[]
  values:Record<string,ConfigValue>
  redacted_keys:string[]
  loaded_revision?:string
  instance_id?:string
  process_id?:number
  managed_instance_id?:string
  overridden_keys?:string[]
  restart_required?:boolean
}
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
  runtime?:{process_id:number;instance_id:string}|null
  restart_required:boolean
  apply_policy:'gateway_restart'
  values:Record<string,ConfigValue>
  redacted_paths:string[]
  overridden_paths:string[]
}
