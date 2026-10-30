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

    setTrack(track: MediaStreamTrack) {
        if (this.disposed || track.readyState === "ended") return
        this.track = track

        this.updateState()
    }

    private updateState() {
        this.dirty = true
        if (this.updating) return
        this.updating = this.reconcile().finally(() => {
            this.updating = null
            if (this.dirty) this.updateState()
        })
    }

    private async replace(sender: RTCRtpSender, track: MediaStreamTrack | null) {
        try { await sender.replaceTrack(track) }
        catch (error) { this.logger?.debug(`Microphone sender update failed: ${error}`) }
    }

    private async reconcile() {
        while (this.dirty) {
            this.dirty = false
            const sender = this.disposed ? null : this.sender
            if (this.boundSender && this.boundSender !== sender) {
                await this.replace(this.boundSender, null)
                this.boundSender = null
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
