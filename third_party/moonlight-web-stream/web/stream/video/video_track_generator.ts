import { RealtimeTrackWriter } from "../pipeline/realtime_track_writer"
import { Logger } from "../log"
import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { allVideoCodecs } from "../video"
import { FrameVideoRenderer, TrackVideoRenderer } from "./index"

export class VideoTrackGeneratorPipe implements FrameVideoRenderer {
    static readonly pipeName = "VideoTrackGeneratorPipe"

    static readonly baseType = "videotrack"
    static readonly type = "videoframe"

    static async getInfo(): Promise<PipeInfo> {
        // https://developer.mozilla.org/en-US/docs/Web/API/VideoTrackGenerator
        return {
            environmentSupported: "VideoTrackGenerator" in globalObject(),
            supportedVideoCodecs: allVideoCodecs()
        }
    }

    readonly implementationName: string

    private base: TrackVideoRenderer

    private trackGenerator: VideoTrackGenerator
    private output: RealtimeTrackWriter<VideoFrame>
    private disposed = false

    constructor(base: TrackVideoRenderer, logger?: Logger) {
        this.implementationName = `video_track_generator -> ${base.implementationName}`
        this.base = base

        this.trackGenerator = new VideoTrackGenerator()
        this.output = new RealtimeTrackWriter<VideoFrame>(this.trackGenerator.writable.getWriter(), this.trackGenerator.track, error => logger?.debug(`Generated video track failed: ${error}`))

        addPipePassthrough(this)
    }

    private isFirstSample = true
    submitFrame(frame: VideoFrame): void {
        if (this.disposed) { frame.close(); return }
        if (this.isFirstSample) {
            this.isFirstSample = false

            this.base.setTrack(this.trackGenerator.track)
        }
        this.output.submit(frame)
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
