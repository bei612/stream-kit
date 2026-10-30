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
  let wanted = false
  let activeToken = ''

  function clearRetry() {
    if (retryTimer != null) clearTimeout(retryTimer)
    retryTimer = null
  }

  function connect() {
    const token = getToken()
    if (!token || !isLoggedIn()) { disconnect(); return }
    wanted = true

    const existing = get().ws
    if (existing && existing.readyState <= WebSocket.OPEN && activeToken === token) return
    clearRetry()
    // Relinquish ownership before closing: a delayed close event from this
    // socket must never clear a replacement connection or schedule a retry.
    set({ ws: null, connected: false })
    existing?.close()
    activeToken = token

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/api/v1/ws`

    let ws: WebSocket
    try { ws = new WebSocket(url, ['stream-kit.events.v1', `stream-kit.auth.${token}`]) }
    catch { scheduleReconnect(); return }

    ws.onopen = () => {
      if (get().ws !== ws || !wanted) return
      if (!isLoggedIn() || getToken() !== token) { connect(); return }
      set({ connected: true, reconnecting: false, ws })
      retryCount = 0
      window.dispatchEvent(new CustomEvent('ws-connected'))
    }

    ws.onclose = () => {
      if (get().ws !== ws) return
      set({ connected: false, ws: null })
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }

    ws.onmessage = (event) => {
      if (get().ws !== ws || !wanted || getToken() !== token) return
      try {
        const msg = JSON.parse(event.data)
        window.dispatchEvent(new CustomEvent('ws-event', { detail: msg }))
      } catch { /* ignore */ }
    }

    set({ ws })
  }

  function scheduleReconnect() {
    if (!wanted || retryTimer != null) return
    // Don't reconnect if token is expired — avoids infinite 401 loop
    if (!isLoggedIn()) {
      disconnect()
      return
    }
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000)
    retryCount++
    set({ reconnecting: true })
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (wanted) connect()
    }, delay)
  }

  function disconnect() {
    wanted = false
    clearRetry()
    retryCount = 0
    activeToken = ''
    const { ws } = get()
    set({ ws: null, connected: false, reconnecting: false })
    ws?.close()
  }

  return { connected: false, reconnecting: false, ws: null, connect, disconnect }
})
