import { CONFIG } from "../config_"

export type MediaAccess = {
    baseUrl: string
    bearer: string
    sessionId: string
    connectionId: string
    ticket: string
    expiresAt: string
    role: "viewer" | "controller"
    microphoneEnabled: boolean
    revision?: number
    controlEpoch?: number
}

type ConnectionResponse = {
    revision: number
    control_epoch: number
    session_id: string
    host_id: number
    app_id: number
    connection_token: string
    connection: { connection_id: string; role: "viewer" | "controller" }
    audio: { microphone_enabled: boolean }
}

export class MediaAccessError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
}

export function managedStreaming(): boolean { return CONFIG.managed_streaming }

function controlBase(): string {
    if (!CONFIG.control_plane_url) throw new Error("Managed streaming requires a configured control plane")
    const url = new URL(CONFIG.control_plane_url, window.location.origin)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw new Error("Invalid control plane configuration")
    }
    if (window.location.protocol === "https:" && url.protocol !== "https:") {
        throw new Error("The control plane must use HTTPS")
    }
    return url.toString().replace(/\/$/, "")
}

async function request<T>(base: string, bearer: string, path: string, method: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 10000)
    try {
        const response = await fetch(`${base}/api/v1${path}`, {
            method, signal: controller.signal, credentials: "omit", cache: "no-store",
            headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        const result = await response.json().catch(() => null)
        if (!response.ok || result?.status !== "ok") {
            throw new MediaAccessError(result?.message || "Connection authorization failed", response.status)
        }
        return result.data as T
    } finally { window.clearTimeout(timer) }
}

function path(access: MediaAccess): string {
    return `/client-sessions/${encodeURIComponent(access.sessionId)}/connections/${encodeURIComponent(access.connectionId)}`
}

export async function acquireMediaAccess(hostId: number, appId: number): Promise<MediaAccess | null> {
    if (!managedStreaming()) return null
    const baseUrl = controlBase()
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const invitation = fragment.get("join")
    fragment.delete("join")
    const url = new URL(window.location.href)
    url.hash = fragment.toString()
    url.searchParams.delete("mediaControlToken")
    url.searchParams.delete("mediaControlUrl")
    url.searchParams.delete("mediaTicket")
    window.history.replaceState(null, "", url)
    if (!invitation) throw new Error("Open a new viewing link from the management page")
    const joined = await request<ConnectionResponse>(baseUrl, invitation, "/client-sessions/join", "POST")
    const access: MediaAccess = {
        baseUrl, bearer: joined.connection_token, sessionId: joined.session_id,
        connectionId: joined.connection.connection_id, role: joined.connection.role,
        microphoneEnabled: joined.audio?.microphone_enabled === true,
        revision: joined.revision, controlEpoch: joined.control_epoch,
        ticket: "", expiresAt: "",
    }
    try {
        validateConnectionState(joined)
        if (joined.host_id !== hostId || joined.app_id !== appId) throw new Error("Viewing link does not match this rendering application")
        await refreshMediaTicket(access)
        return access
    } catch (error) {
        await releaseMediaAccess(access).catch(() => {})
        throw error
    }
}

export async function refreshMediaTicket(access: MediaAccess): Promise<void> {
    const ticket = await request<{ ticket: string; expires_at: string; role: "viewer" | "controller" }>(access.baseUrl, access.bearer, `${path(access)}/ticket`, "POST")
    access.ticket = ticket.ticket
    access.expiresAt = ticket.expires_at
    // Tickets admit media; only the connection snapshot controls capture.
    // A concurrent ticket response must not overwrite a newer heartbeat role.
}

export async function mediaHeartbeat(access: MediaAccess, microphone: boolean, live: boolean): Promise<void> {
    const current = await request<ConnectionResponse>(access.baseUrl, access.bearer, `${path(access)}/heartbeat`, "POST", { microphone, microphone_live: live })
    applyConnectionState(access, current)
}

function validateConnectionState(current: ConnectionResponse): void {
    if (!Number.isSafeInteger(current?.revision) || current.revision! < 0 ||
        !Number.isSafeInteger(current?.control_epoch) || current.control_epoch! < 0 ||
        typeof current.session_id !== "string" || !current.session_id ||
        typeof current.connection?.connection_id !== "string" || !current.connection.connection_id ||
        typeof current.connection_token !== "string" || !current.connection_token ||
        !["viewer", "controller"].includes(current.connection.role) ||
        typeof current.audio?.microphone_enabled !== "boolean") {
        throw new MediaAccessError("Invalid connection authority snapshot", 502)
    }
}

function applyConnectionState(access: MediaAccess, current: ConnectionResponse): void {
    validateConnectionState(current)
    if (current.session_id !== access.sessionId || current.connection.connection_id !== access.connectionId) {
        throw new MediaAccessError("Connection identity does not match", 401)
    }
    if (Number.isSafeInteger(current.revision) && Number.isSafeInteger(access.revision) && current.revision! < access.revision!) return
    if (Number.isSafeInteger(access.controlEpoch) && current.control_epoch! < access.controlEpoch!) {
        throw new MediaAccessError("Connection control epoch regressed", 502)
    }
    access.bearer = current.connection_token
    access.role = current.connection.role
    access.microphoneEnabled = current.audio?.microphone_enabled === true
    access.revision = current.revision
    access.controlEpoch = current.control_epoch
}

export async function releaseMediaAccess(access: MediaAccess): Promise<void> {
    await request(access.baseUrl, access.bearer, path(access), "DELETE")
}

export async function resumeMediaAccess(access: MediaAccess): Promise<void> {
    const current = await request<ConnectionResponse>(access.baseUrl, access.bearer, `${path(access)}/resume`, "POST")
    applyConnectionState(access, current)
    await refreshMediaTicket(access)
}
