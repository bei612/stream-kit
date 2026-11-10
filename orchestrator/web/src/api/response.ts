export interface Pagination { page: number; size: number; total: number }
export interface ApiResponse<T = unknown> {
  status: 'ok' | 'error'
  data?: T
  code?: string
  message?: string
  request_id?: string
  pagination?: Pagination
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Validate the shared transport envelope once for fetch, login and uploads.
// Endpoint payload types come from the matching server management projections.
// Never include an invalid response body or authentication token in the error.
export function decodeApiResponse<T>(value: unknown): ApiResponse<T> {
  if (!record(value) || (value.status !== 'ok' && value.status !== 'error')) throw new Error('服务器响应格式无效')
  for (const key of ['code', 'message', 'request_id']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('服务器响应格式无效')
  }
  const pagination = value.pagination
  if (pagination !== undefined && (!record(pagination) ||
    !Number.isSafeInteger(pagination.page) || (pagination.page as number) < 1 ||
    !Number.isSafeInteger(pagination.size) || (pagination.size as number) < 1 ||
    !Number.isSafeInteger(pagination.total) || (pagination.total as number) < 0)) throw new Error('服务器分页信息无效')
  return value as unknown as ApiResponse<T>
}
