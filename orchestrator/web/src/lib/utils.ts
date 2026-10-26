import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}时${m}分`
}

export function formatTime(dateStr: string): string {
  if (!dateStr || dateStr.startsWith('0001')) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

export const API_BASE = '/api/v1'

export function getToken(): string {
  return localStorage.getItem('auth_token') || ''
}

export function setToken(token: string) {
  localStorage.setItem('auth_token', token)
}

export function clearToken() {
  localStorage.removeItem('auth_token')
}

export function isLoggedIn(): boolean {
  const token = getToken()
  if (!token) return false
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.exp * 1000 > Date.now()
  } catch {
    return false
  }
}

// Convert single-line args string to multi-line (one arg per line).
// Respects quoted arguments: `-logdir "C:\My Path"` stays as one line.
export function argsToLines(args: string): string {
  if (!args.trim()) return ''
  const result: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''
  for (const ch of args) {
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true
      quoteChar = ch
      current += ch
    } else if (inQuote && ch === quoteChar) {
      inQuote = false
      current += ch
    } else if (ch === ' ' && !inQuote) {
      if (current) { result.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) result.push(current)
  return result.join('\n')
}

// Convert multi-line args (one per line) back to single-line space-separated.
export function linesToArgs(lines: string): string {
  return lines
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ')
}
