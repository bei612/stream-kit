import { RealtimeTrackWriter } from "../pipeline/realtime_track_writer"
import { Logger } from "../log"
import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { SampleAudioPlayer, TrackAudioPlayer } from "./index"

export class AudioMediaStreamTrackGeneratorPipe implements SampleAudioPlayer {
    static readonly pipeName = "AudioMediaStreamTrackGeneratorPipe"

    static readonly baseType = "audiotrack"
    static readonly type = "audiosample"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: "MediaStreamTrackGenerator" in globalObject()
        }
    }

    implementationName: string

    private base: TrackAudioPlayer

    private trackGenerator: MediaStreamTrackGenerator
    private output: RealtimeTrackWriter<AudioData>
    private disposed = false

    constructor(base: TrackAudioPlayer, logger?: Logger) {
        this.implementationName = `audio_media_stream_track_generator -> ${base.implementationName}`
        this.base = base

        this.trackGenerator = new MediaStreamTrackGenerator({ kind: "audio" })
        this.output = new RealtimeTrackWriter<AudioData>(this.trackGenerator.writable.getWriter(), this.trackGenerator, error => logger?.debug(`Generated audio track failed: ${error}`))

        addPipePassthrough(this)
    }

    private isFirstSample = true
    submitSample(sample: AudioData): void {
        if (this.disposed) { sample.close(); return }
        if (this.isFirstSample) {
            this.isFirstSample = false

            this.base.setTrack(this.trackGenerator)
        }
        this.output.submit(sample)
    }

    cleanup(): void {
        if (this.disposed) return
        this.disposed = true
        this.output.close()
        if ("cleanup" in this.base && typeof this.base.cleanup === "function") this.base.cleanup()
    }

    getBase(): Pipe | null {
        return this.base
    }

}
