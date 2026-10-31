import { MicrophoneSink } from ".";
import { showNotification } from "../../component/notification";
import { globalObject } from "../../util";
import { Logger } from "../log";
import { Pipe, PipeInfo } from "../pipeline";
import { addPipePassthrough } from "../pipeline/pipes";
import { MicrophoneCapture, MicrophoneInputOptions } from "./microphone_capture";

export interface MicrophoneSource extends Pipe {
    cleanup(): void
    isLive(): boolean
    setAllowed(allowed: boolean): void
    resumeCapture(): Promise<void>
    configure(input: MicrophoneInputOptions): void
}

export class MicrophonePipe implements MicrophoneSource {
    static readonly pipeName = "MicrophonePipe"

    static readonly baseType = "audiotrack"
    static readonly type = "none"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: MicrophoneCapture.supported(globalObject())
        }
    }

    readonly implementationName: string

    private logger: Logger | null = null

    private base: MicrophoneSink

    private capture = new MicrophoneCapture()
    private disposed = false
    private generation = 0
    private attachedTrack: MediaStreamTrack | null = null
    private pendingCapture: Promise<void> | null = null

    constructor(base: MicrophoneSink, logger?: Logger) {
        this.implementationName = `microphone -> ${base.implementationName}`

        this.logger = logger ?? null

        this.base = base

        addPipePassthrough(this)
    }

    private tryRequestMicrophone(): Promise<void> {
        if (this.disposed) return Promise.resolve()
        if (this.pendingCapture) return this.pendingCapture
        const pending = this.requestMicrophone().finally(() => {
            if (this.pendingCapture === pending) this.pendingCapture = null
        })
        this.pendingCapture = pending
        return pending
    }

    private async requestMicrophone() {
        const generation = this.generation
        this.logger?.debug("Requesting microphone capture")
        try {
            const track = await this.capture.acquire()
            if (track && generation === this.generation && this.capture.owns(track) && track !== this.attachedTrack) {
                await this.base.setTrack(track)
                if (generation === this.generation && this.capture.owns(track)) this.attachedTrack = track
            }
        } catch (e) {
            if (this.disposed || generation !== this.generation) return
            this.capture.release()
            this.attachedTrack = null
            this.base.clearTrack()
            this.logger?.debug(`Failed to acquire microphone: ${e}`)
            showNotification("Microphone could not start. Check the device, permission and connection, then try again.")
            return
        }
    }

    isLive(): boolean { return this.attachedTrack !== null && this.capture.isLive() }
    configure(input: MicrophoneInputOptions): void { this.capture.configure(input) }
    resumeCapture(): Promise<void> { return this.tryRequestMicrophone() }
    setAllowed(allowed: boolean): void {
        if (!allowed) {
            this.generation++
            this.attachedTrack = null
        }
        this.capture.setAllowed(allowed)
        if (!allowed && !this.disposed) this.base.clearTrack()
    }

    cleanup(): void {
        if (this.disposed) return
        this.disposed = true
        this.generation++
        this.attachedTrack = null
        this.capture.dispose()
        this.base.cleanup()
    }

    onUserInteraction() {
        if (this.disposed) return
        this.tryRequestMicrophone()

        if ("onUserInteraction" in this.base && typeof this.base.onUserInteraction == "function") {
            return this.base.onUserInteraction(...arguments)
        }
    }

    getBase(): Pipe | null {
        return this.base
    }
}
