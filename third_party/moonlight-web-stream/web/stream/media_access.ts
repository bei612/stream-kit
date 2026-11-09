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
    lifecycle?: "active" | "released" | "terminated"
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
    credentialSuperseded = false
    constructor(message: string, readonly status: number, readonly code: string = "") { super(message) }
}

export function mediaAccessActive(access: MediaAccess): boolean {
    return access.lifecycle !== "terminated" && access.lifecycle !== "released"
}

export function terminateMediaAccess(access: MediaAccess): void {
    access.lifecycle = "terminated"
    access.ticket = ""
    access.expiresAt = ""
    access.microphoneEnabled = false
}

export function terminalMediaAccessError(error: unknown): boolean {
    return error instanceof MediaAccessError && ((error.status === 401 && !error.credentialSuperseded) ||
        (error.status === 410 && !["CONNECTION_LEASE_EXPIRED", "CONNECTION_EXPIRED"].includes(error.code)))
}

function observeAccessFailure(access: MediaAccess, bearer: string, error: unknown, resuming = false): void {
    if (error instanceof MediaAccessError && error.status === 401 && bearer !== access.bearer) {
        // A rejection of an older token does not invalidate the newer token
        // already installed for this same connection. Keep the error visible.
        error.credentialSuperseded = true
        return
    }
    if (terminalMediaAccessError(error) || (resuming && error instanceof MediaAccessError && error.status === 410)) {
        terminateMediaAccess(access)
    }
}

export function resumableMediaAccessError(error: unknown): boolean {
    // Older control planes use CONNECTION_EXPIRED for both lease and terminal
    // expiry. Resume can confirm that legacy response; a definitive 401/410
    // rejection is terminal. A network failure leaves the outcome unknown.
    return error instanceof MediaAccessError && error.status === 410 &&
        ["CONNECTION_LEASE_EXPIRED", "CONNECTION_EXPIRED"].includes(error.code)
}

function requireActive(access: MediaAccess): void {
    if (!mediaAccessActive(access)) throw new MediaAccessError("Managed connection is closed", 410, "CONNECTION_TERMINATED")
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
            throw new MediaAccessError(result?.message || "Connection authorization failed", response.status,
                typeof result?.code === "string" ? result.code : "")
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
    const joined = await request<ConnectionResponse>(baseUrl, invitation, "/client-sessions/join", "POST", { client_type: "web" })
    const access: MediaAccess = {
        baseUrl, bearer: joined.connection_token, sessionId: joined.session_id,
        connectionId: joined.connection.connection_id, role: joined.connection.role,
        microphoneEnabled: joined.audio?.microphone_enabled === true,
        revision: joined.revision, controlEpoch: joined.control_epoch,
        ticket: "", expiresAt: "",
        lifecycle: "active",
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
    requireActive(access)
    const bearer = access.bearer
    try {
        const ticket = await request<{ ticket: string; expires_at: string; role: "viewer" | "controller" }>(access.baseUrl, bearer, `${path(access)}/ticket`, "POST")
        if (!mediaAccessActive(access)) return
        access.ticket = ticket.ticket
        access.expiresAt = ticket.expires_at
    } catch (error) {
        observeAccessFailure(access, bearer, error)
        throw error
    }
    // Tickets admit media; only the connection snapshot controls capture.
    // A concurrent ticket response must not overwrite a newer heartbeat role.
}

export async function mediaHeartbeat(access: MediaAccess, microphone: boolean, live: boolean): Promise<void> {
    requireActive(access)
    const bearer = access.bearer
    try {
        const current = await request<ConnectionResponse>(access.baseUrl, bearer, `${path(access)}/heartbeat`, "POST", { microphone, microphone_live: live })
        if (mediaAccessActive(access)) applyConnectionState(access, current)
    } catch (error) {
        observeAccessFailure(access, bearer, error)
        throw error
    }
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

const releases = new WeakMap<MediaAccess, Promise<void>>()
export function releaseMediaAccess(access: MediaAccess): Promise<void> {
    const pending = releases.get(access)
    if (pending) return pending
    if (!mediaAccessActive(access)) return Promise.resolve()
    access.lifecycle = "released"
    const release = request<void>(access.baseUrl, access.bearer, path(access), "DELETE")
    releases.set(access, release)
    return release
}

export async function resumeMediaAccess(access: MediaAccess): Promise<void> {
    requireActive(access)
    const bearer = access.bearer
    try {
        const current = await request<ConnectionResponse>(access.baseUrl, bearer, `${path(access)}/resume`, "POST")
        if (!mediaAccessActive(access)) return
        applyConnectionState(access, current)
    } catch (error) {
        observeAccessFailure(access, bearer, error, true)
        throw error
    }
}
