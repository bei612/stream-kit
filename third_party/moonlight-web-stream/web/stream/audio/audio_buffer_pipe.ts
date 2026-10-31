import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { AudioPcmUnit, AudioPlayerSetup, NodeAudioPlayer, PcmAudioPlayer } from "./index"

const TARGET_LATENCY_SECS = 0.12
const MAX_LATENCY_SECS = 0.25
const MAX_QUEUED_SOURCES = 128

export class AudioBufferPipe implements PcmAudioPlayer {
    static readonly pipeName = "AudioBufferPipe"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: "AudioBufferSourceNode" in globalObject()
        }
    }

    static readonly baseType = "audionode"
    static readonly type = "audiopcm"

    readonly implementationName: string

    private base: NodeAudioPlayer

    constructor(base: NodeAudioPlayer) {
        this.implementationName = `audio_pcm_buffer -> ${base.implementationName}`
        this.base = base

        addPipePassthrough(this)
    }

    private channels: number = -1
    private sampleRate: number = -1

    private node: AudioNode | null = null
    private sources = new Set<AudioBufferSourceNode>()

    private clearScheduled(): void {
        for (const source of this.sources) {
            source.onended = null
            try { source.stop() } catch { /* Already ended. */ }
            source.disconnect()
        }
        this.sources.clear()
        this.nextAudioPlayTime = null
    }

    cleanup(): void {
        this.clearScheduled()
        this.node?.disconnect()
        this.node = null
        this.hadUserInteraction = false
        if ("cleanup" in this.base && typeof this.base.cleanup === "function") this.base.cleanup()
    }

    setup(setup: AudioPlayerSetup) {
        this.channels = setup.channels
        this.sampleRate = setup.sampleRate

        let result
        if ("setup" in this.base && typeof this.base.setup == "function") {
            this.base.setup(...arguments)
        }

        this.node = this.base.getAudioContext().createGain()

        this.base.setSource(this.node)

        return result
    }

    private hadUserInteraction: boolean = false

    onUserInteraction() {
        this.hadUserInteraction = true

        if ("onUserInteraction" in this.base && typeof this.base.onUserInteraction == "function") {
            return this.base.onUserInteraction(...arguments)
        }
    }

    private nextAudioPlayTime: number | null = null

    playPcm(unit: AudioPcmUnit): void {
        if (!this.node) {
            return
        }
        if (!this.hadUserInteraction) {
            return
        }

        const context = this.base.getAudioContext()
        if (context.state !== "running") {
            // A suspended context has a frozen clock. Never accumulate media
            // against that clock or replay stale speech after activation.
            this.clearScheduled()
            return
        }
        const samples = unit.channelData[0]?.length ?? 0
        if (samples === 0 || this.sampleRate <= 0 || samples / this.sampleRate > MAX_LATENCY_SECS ||
            unit.channelData.length !== this.channels || unit.channelData.some(channel => channel.length !== samples)) return

        const now = context.currentTime
        const initialDelay = Math.min(TARGET_LATENCY_SECS, MAX_LATENCY_SECS - samples / this.sampleRate)

        if (this.nextAudioPlayTime == null) {
            this.nextAudioPlayTime = now + initialDelay
        }

        let ahead = this.nextAudioPlayTime - now

        // Remove scheduled audio before resetting the clock, otherwise old
        // and new buffers overlap. Bound node count even for tiny PCM units.
        if (ahead + samples / this.sampleRate > MAX_LATENCY_SECS || this.sources.size >= MAX_QUEUED_SOURCES) {
            this.clearScheduled()
            this.nextAudioPlayTime = now + initialDelay;
            ahead = initialDelay;
        }

        // Underrun -> jump forward
        if (ahead < 0) {
            console.debug("Audio underrun")

            // We are behind (underrun), jump to current time + small buffer
            this.nextAudioPlayTime = now + initialDelay;
        }

        const buffer = context.createBuffer(this.channels, unit.channelData[0].length, this.sampleRate)

        for (let channel = 0; channel < this.channels; channel++) {
            const channelPcm = unit.channelData[channel]

            buffer.copyToChannel(channelPcm, channel)
        }

        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(this.node)

        this.sources.add(source)
        source.onended = () => { this.sources.delete(source); source.disconnect() }
        source.start(this.nextAudioPlayTime)
        this.nextAudioPlayTime += buffer.duration
    }

    getBase(): Pipe | null {
        return this.base
    }
}
