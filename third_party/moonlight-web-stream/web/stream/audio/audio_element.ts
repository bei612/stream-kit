import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { AudioPlayerSetup, TrackAudioPlayer } from "./index"
import { Logger } from "../log"

export class AudioElementPlayer implements TrackAudioPlayer {
    static readonly pipeName = "AudioElementPlayer"

    static readonly type = "audiotrack"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: "HTMLAudioElement" in globalObject() && "srcObject" in HTMLAudioElement.prototype,
        }
    }

    readonly implementationName: string = "audio_element"

    private audioElement = document.createElement("audio")
    private oldTrack: MediaStreamTrack | null = null
    private stream = new MediaStream()
    private disposed = false
    private playPending = false
    private generation = 0

    constructor(private logger?: Logger) {
        this.implementationName = "audio_element"

        this.audioElement.classList.add("audio-stream")
        this.audioElement.preload = "none"
        this.audioElement.controls = false
        this.audioElement.autoplay = true
        this.audioElement.muted = true
        this.audioElement.srcObject = this.stream

        addPipePassthrough(this)
    }

    setup(_setup: AudioPlayerSetup) {
        this.disposed = false
        this.audioElement.srcObject = this.stream
        return true
    }
    cleanup(): void {
        this.disposed = true
        this.generation++
        this.playPending = false
        this.audioElement.pause()
        this.audioElement.muted = true
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
            this.oldTrack = null
        }
        this.audioElement.srcObject = null
    }

    setTrack(track: MediaStreamTrack): void {
        if (this.disposed) return
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
            this.oldTrack = null
        }

        this.stream.addTrack(track)
        this.oldTrack = track
    }

    onUserInteraction(): void {
        if (this.disposed) return
        this.audioElement.muted = false
        // Unmuting alone does not restart playback denied by autoplay policy.
        // Call synchronously inside the gesture, before any await loses activation.
        if (this.audioElement.paused && !this.playPending) {
            const generation = this.generation
            this.playPending = true
            void this.audioElement.play().catch(error => {
                if (!this.disposed && this.generation === generation) this.logger?.debug(`Audio playback requires another user interaction: ${error}`)
            }).finally(() => { if (this.generation === generation) this.playPending = false })
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.audioElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.audioElement)
    }

    getBase(): Pipe | null {
        return null
    }
}
