import { create } from 'zustand'
import { getToken, isLoggedIn } from '@/lib/utils'

interface WSState {
  connected: boolean
  reconnecting: boolean
  ws: WebSocket | null
  connect: () => void
  disconnect: () => void
}

export const useWSStore = create<WSState>((set, get) => {
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false

  function connect() {
    const token = getToken()
    if (!token) return

    // Close existing connection if any
    const existing = get().ws
    if (existing && existing.readyState <= WebSocket.OPEN) {
      intentionalClose = true
      existing.close()
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/api/v1/ws?token=${token}`

    const ws = new WebSocket(url)

    ws.onopen = () => {
      set({ connected: true, reconnecting: false, ws })
      retryCount = 0
      intentionalClose = false
    }

    ws.onclose = () => {
      set({ connected: false, ws: null })
      if (!intentionalClose) {
        scheduleReconnect()
      }
      intentionalClose = false
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        window.dispatchEvent(new CustomEvent('ws-event', { detail: msg }))
      } catch { /* ignore */ }
    }

    set({ ws })
  }

  function scheduleReconnect() {
    if (retryTimer) return
    // Don't reconnect if token is expired — avoids infinite 401 loop
    if (!isLoggedIn()) {
      set({ reconnecting: false })
      return
    }
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000)
    retryCount++
    set({ reconnecting: true })
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (isLoggedIn()) connect()
    }, delay)
  }

  function disconnect() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    intentionalClose = true
    const { ws } = get()
    if (ws) {
      ws.close()
    }
    set({ ws: null, connected: false, reconnecting: false })
  }

  return { connected: false, reconnecting: false, ws: null, connect, disconnect }
})
