import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { allVideoCodecs } from "../video"
import { FrameVideoRenderer, TrackVideoRenderer, VideoRendererSetup } from "./index"

export class VideoMediaStreamTrackProcessorPipe implements TrackVideoRenderer {
    static readonly pipeName = "VideoMediaStreamTrackProcessorPipe"

    static readonly baseType = "videoframe"
    static readonly type = "videotrack"

    static async getInfo(): Promise<PipeInfo> {
        // https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor
        return {
            environmentSupported: "MediaStreamTrackProcessor" in globalObject(),
            supportedVideoCodecs: allVideoCodecs()
        }
    }

    readonly implementationName: string

    private running: boolean = false
    private disposed = false
    private setupPromise: Promise<void> | null = null
    private track: MediaStreamTrack | null = null
    private reader: ReadableStreamDefaultReader<VideoFrame> | null = null
    private trackProcessor: MediaStreamTrackProcessor | null = null

    private base: FrameVideoRenderer

    constructor(base: FrameVideoRenderer) {
        this.implementationName = `media_stream_track_processor -> ${base.implementationName}`
        this.base = base

        addPipePassthrough(this)
    }

    setTrack(track: MediaStreamTrack): void {
        if (this.disposed) return
        this.track = track
        if (this.running) this.startReader()
    }

    private cancelReader() {
        const reader = this.reader
        this.reader = null
        this.trackProcessor = null
        // Cancel the owner of the lock, not the locked ReadableStream. This
        // also resolves a pending read when a track has stopped producing.
        if (reader) void reader.cancel().catch(error => console.error("Video reader cancellation failed", error))
    }

    private startReader() {
        this.cancelReader()
        if (!this.track || this.disposed || !this.running) return
        this.trackProcessor = new MediaStreamTrackProcessor({ track: this.track, maxBufferSize: 1 })
        const reader = this.reader = this.trackProcessor.readable.getReader()
        void this.readTrack(reader)
    }

    private async readTrack(reader: ReadableStreamDefaultReader<VideoFrame>) {
        try {
            while (this.running && this.reader === reader) {
                const { done, value } = await reader.read()
                if (done) return
                // Replacement/cleanup can complete while native read resolves.
                if (!this.running || this.reader !== reader) { value.close(); return }
                try { this.base.submitFrame(value) }
                catch (error) { value.close(); throw error }
            }
        } catch (error) {
            if (this.running && this.reader === reader) console.error("Video track processing failed", error)
        } finally {
            if (this.reader === reader) { this.reader = null; this.trackProcessor = null }
            // Cancel also drains native buffered frames after rendering errors.
            try { await reader.cancel() }
            catch (error) { console.error("Video reader cleanup failed", error) }
            finally { reader.releaseLock() }
        }
    }

    setup(setup: VideoRendererSetup): Promise<void> {
        if (this.disposed || this.running) return Promise.resolve()
        if (this.setupPromise) return this.setupPromise
        // A pipeline may receive overlapping setup/track/close events. Only
        // one initialization owns the base renderer and can start a reader.
        this.setupPromise = Promise.resolve().then(async () => {
            if (this.disposed) return
            if ("setup" in this.base && typeof this.base.setup == "function") {
                await this.base.setup(setup)
            }
            if (this.disposed) return
            this.running = true
            this.startReader()
        }).finally(() => { this.setupPromise = null })
        return this.setupPromise
    }
    cleanup() {
        if (this.disposed) return
        this.disposed = true
        this.running = false
        this.track = null
        this.cancelReader()

        if ("cleanup" in this.base && typeof this.base.cleanup == "function") {
            return this.base.cleanup(...arguments)
        }
    }

    getBase(): Pipe | null {
        return this.base
    }
}
