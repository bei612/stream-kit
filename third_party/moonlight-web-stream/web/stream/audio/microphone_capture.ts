/** Owns the browser recording resource independently of a particular transport. */
export type MicrophoneInputOptions = {
    deviceId: string
    echoCancellation: boolean
    noiseSuppression: boolean
    autoGainControl: boolean
}

export function microphoneInputOptions(value?: Partial<MicrophoneInputOptions> | null): MicrophoneInputOptions {
    return {
        deviceId: typeof value?.deviceId === "string" && value.deviceId.length <= 4096 ? value.deviceId : "",
        echoCancellation: typeof value?.echoCancellation === "boolean" ? value.echoCancellation : true,
        noiseSuppression: typeof value?.noiseSuppression === "boolean" ? value.noiseSuppression : true,
        autoGainControl: typeof value?.autoGainControl === "boolean" ? value.autoGainControl : true,
    }
}

export class MicrophoneCapture {
    private track: MediaStreamTrack | null = null
    private pending: Promise<MediaStreamTrack | null> | null = null
    private disposed = false
    private allowed = true
    private generation = 0
    private request: () => Promise<MediaStream>
    private input = microphoneInputOptions()

    constructor(request?: () => Promise<MediaStream>) {
        this.request = request ?? (() => navigator.mediaDevices.getUserMedia({
            audio: {
                ...(this.input.deviceId ? { deviceId: { exact: this.input.deviceId } } : {}),
                echoCancellation: this.input.echoCancellation,
                noiseSuppression: this.input.noiseSuppression,
                autoGainControl: this.input.autoGainControl,
            }, video: false,
        }))
    }

    configure(input?: Partial<MicrophoneInputOptions>): void {
        if (this.pending || this.isLive()) throw new Error("Microphone input changes require a new connection")
        this.input = microphoneInputOptions(input)
    }

    static supported(environment: { isSecureContext?: boolean; navigator?: { mediaDevices?: { getUserMedia?: unknown } } }): boolean {
        return environment.isSecureContext === true &&
            typeof environment.navigator?.mediaDevices?.getUserMedia === "function"
    }

    isLive(): boolean {
        return this.track?.readyState === "live" && this.track.enabled && !this.track.muted
    }

    /** Recheck ownership after an await, before attaching a track to transport. */
    owns(track: MediaStreamTrack): boolean {
        return !this.disposed && this.allowed && this.track === track && track.readyState === "live"
    }

    acquire(): Promise<MediaStreamTrack | null> {
        if (this.disposed || !this.allowed) return Promise.resolve(null)
        if (this.track?.readyState === "live") return Promise.resolve(this.track)
        if (this.pending) return this.pending
        this.pending = this.open().finally(() => { this.pending = null })
        return this.pending
    }

    private async open(): Promise<MediaStreamTrack | null> {
        const generation = this.generation
        const stream = await this.request()
        if (this.disposed || !this.allowed || this.generation !== generation) {
            stream.getTracks().forEach(track => track.stop())
            return null
        }
        const track = stream.getAudioTracks()[0]
        stream.getTracks().filter(other => other !== track).forEach(other => other.stop())
        if (!track) throw new Error("No microphone audio track was returned")
        this.track = track
        return track
    }

    dispose(): void {
        this.disposed = true
        this.setAllowed(false)
    }

    setAllowed(allowed: boolean): void {
        if (this.allowed === allowed) return
        this.allowed = allowed
        if (allowed) return // New authority never starts capture without a gesture.
        this.generation++
        this.track?.stop()
        this.track = null
    }
}
