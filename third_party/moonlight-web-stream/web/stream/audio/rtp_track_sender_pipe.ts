import { MicrophoneSink } from ".";
import { globalObject } from "../../util";
import { Pipe, PipeInfo } from "../pipeline";
import { addPipePassthrough } from "../pipeline/pipes";
import { Logger } from "../log";

export class RtpTrackSenderPipe implements MicrophoneSink {
    static readonly pipeName = "RtpTrackSender"

    static readonly type = "audiotrack"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: "RTCRtpSender" in globalObject(),
        }
    }

    readonly implementationName: string = "rtp_audio_track_sender"

    private track: MediaStreamTrack | null = null

    private sender: RTCRtpSender | null = null
    private boundSender: RTCRtpSender | null = null
    private disposed = false
    private dirty = false
    private updating: Promise<void> | null = null

    constructor(private logger?: Logger) {
        addPipePassthrough(this)
    }

    setRtpSender(sender: RTCRtpSender) {
        if (this.disposed) return
        this.sender = sender

        this.updateState()
    }

    async setTrack(track: MediaStreamTrack): Promise<void> {
        if (this.disposed || track.readyState === "ended") return
        this.track = track

        await this.updateState()
        // An intent arriving between reconcile completion and its finalizer is
        // drained by the next batch; do not acknowledge that intent early.
        while (this.updating) await this.updating
    }

    clearTrack(): void {
        if (this.disposed || !this.track) return
        this.track = null
        this.updateState()
    }

    private updateState(): Promise<void> {
        this.dirty = true
        if (this.updating) return this.updating
        this.updating = this.reconcile().finally(() => {
            this.updating = null
            if (this.dirty) this.updateState()
        })
        // Lifecycle setters do not await a binding. Consume their failures here
        // while preserving the same rejection for the capture owner's await.
        void this.updating.catch(error => this.logger?.debug(`Microphone sender update failed: ${error}`))
        return this.updating
    }

    private async replace(sender: RTCRtpSender, track: MediaStreamTrack | null) {
        await sender.replaceTrack(track)
    }

    private async reconcile() {
        while (this.dirty) {
            this.dirty = false
            const sender = this.disposed ? null : this.sender
            if (this.boundSender && this.boundSender !== sender) {
                const previous = this.boundSender
                this.boundSender = null
                await this.replace(previous, null)
                // State may change while detaching; re-read it before attaching.
                this.dirty = true
                continue
            }
            if (sender) {
                this.boundSender = sender
                await this.replace(sender, this.track?.readyState === "live" ? this.track : null)
            }
        }
    }

    cleanup(): void {
        if (this.disposed) return
        this.disposed = true
        this.track = null
        this.sender = null
        this.updateState()
    }

    getBase(): Pipe | null {
        return null
    }
}
