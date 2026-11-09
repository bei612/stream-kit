import type { RenderSession, SessionConnection } from '@/api/sessions'

export interface SessionApplication {
  id: string
  name: string
  sunshine_app_id: number
  stream_url?: string
  status: string
  lifecycle?: { can_stop: boolean }
}

// This is display association only. Native application IDs are scoped to a
// renderer, so never label a remote or historical host by a local ID match alone.
export function findSessionApplication(apps: SessionApplication[], session: Pick<RenderSession, 'host_id' | 'app_id'>) {
  const matches = apps.filter(app => {
    if (app.sunshine_app_id !== session.app_id || !app.stream_url) return false
    try {
      const query = new URL(app.stream_url, 'http://session-display.invalid/').searchParams
      return query.getAll('hostId').length === 1 && query.getAll('appId').length === 1 &&
        query.get('hostId') === String(session.host_id) && query.get('appId') === String(session.app_id)
    } catch { return false }
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function isLiveConnection(connection: SessionConnection, now: number): boolean {
  return connection.state === 'connected' && Date.parse(connection.expires_at) > now
}

export function sessionOverview(sessions: RenderSession[], now: number) {
  // An empty audience does not end an application's streaming generation.
  const current = sessions.filter(session => session.state !== 'stopped')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const history = sessions.filter(session => session.state === 'stopped')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  let clients = 0
  let controllers = 0
  for (const session of current) {
    for (const connection of Object.values(session.connections)) {
      if (!isLiveConnection(connection, now)) continue
      clients++
      if (connection.connection_id === session.controller_connection_id) controllers++
    }
  }
  return { current, history, clients, controllers }
}
