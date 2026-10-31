import { globalObject } from "../../util"
import { Logger } from "../log"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { AudioDecodeUnit, AudioPlayerSetup, DataAudioPlayer, SampleAudioPlayer } from "./index"

async function detectCodec(): Promise<boolean> {
    if (!("isConfigSupported" in AudioDecoder)) {
        // Opus is most likely supported
        return true
    }

    const supported = await AudioDecoder.isConfigSupported({
        codec: "opus",
        // normal Stereo configuration
        numberOfChannels: 2,
        sampleRate: 48000
    })

    return supported?.supported ?? false
}

export class AudioDecoderPipe implements DataAudioPlayer {
    static readonly pipeName = "AudioDecoderPipe"

    static readonly baseType = "audiosample"
    static readonly type = "audiodata"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: "AudioDecoder" in globalObject() && await detectCodec(),
        }
    }

    readonly implementationName: string

    private logger: Logger | null = null

    private base: SampleAudioPlayer

    private errored = false
    private disposed = false
    private maxQueuedPackets = 12
    private decoder: AudioDecoder

    constructor(base: SampleAudioPlayer, logger?: Logger) {
        this.implementationName = `audio_decoder -> ${base.implementationName}`
        this.logger = logger ?? null

        this.base = base

        this.decoder = new AudioDecoder({
            error: this.onError.bind(this),
            output: this.onOutput.bind(this)
        })

        addPipePassthrough(this)
    }

    private onError(error: any) {
        if (this.disposed || this.errored) return
        this.errored = true

        this.logger?.debug(`AudioDecoder has an error ${String(error)}`, { type: "fatal" })
    }

    private onOutput(sample: AudioData) {
        if (this.disposed || this.errored) { sample.close(); return }
        try { this.base.submitSample(sample) }
        catch (error) { sample.close(); this.onError(error) }
    }

    setup(setup: AudioPlayerSetup): void {
        if (this.disposed) return
        if (!Number.isInteger(setup.samplesPerFrame) || setup.samplesPerFrame <= 0 ||
            !Number.isInteger(setup.sampleRate) || setup.sampleRate <= 0 ||
            setup.samplesPerFrame > setup.sampleRate * 0.12) throw new Error("Invalid audio frame timing")
        // Bound the requested decode queue to roughly 250 ms, with a hard
        // packet cap for unusually small frames. Do not allocate another queue.
        this.maxQueuedPackets = Math.max(1, Math.min(64, Math.floor(0.25 * setup.sampleRate / setup.samplesPerFrame)))
        this.isFirstPacket = true
        if ("setup" in this.base && typeof this.base.setup == "function") {
            this.base.setup(setup)
        }

        this.decoder.configure({
            codec: "opus",
            numberOfChannels: setup.channels,
            sampleRate: setup.sampleRate
        })
    }

    private isFirstPacket = true

    decodeAndPlay(unit: AudioDecodeUnit): void {
        if (this.disposed || this.errored || this.decoder.state !== "configured" || this.decoder.decodeQueueSize >= this.maxQueuedPackets) {
            return
        }

        try {
            const chunk = new EncodedAudioChunk({
                type: this.isFirstPacket ? "key" : "delta",
                data: unit.data,
                timestamp: unit.timestampMicroseconds,
                duration: unit.durationMicroseconds,
            })
            this.decoder.decode(chunk)
            this.isFirstPacket = false
        } catch (error) { this.onError(error) }
    }

    cleanup(): void {
        if (this.disposed) return
        this.disposed = true
        try {
            if (this.decoder.state !== "closed") this.decoder.close()
        } finally {
            if ("cleanup" in this.base && typeof this.base.cleanup == "function") this.base.cleanup()
        }
    }

    getBase(): Pipe | null {
        return this.base
    }

}
