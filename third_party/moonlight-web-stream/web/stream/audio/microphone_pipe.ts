import { MicrophoneSink } from ".";
import { showNotification } from "../../component/notification";
import { globalObject } from "../../util";
import { Logger } from "../log";
import { Pipe, PipeInfo } from "../pipeline";
import { addPipePassthrough } from "../pipeline/pipes";
import { MicrophoneCapture } from "./microphone_capture";

export interface MicrophoneSource extends Pipe {
    cleanup(): void
    isLive(): boolean
    setAllowed(allowed: boolean): void
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

    constructor(base: MicrophoneSink, logger?: Logger) {
        this.implementationName = `microphone -> ${base.implementationName}`

        this.logger = logger ?? null

        this.base = base

        addPipePassthrough(this)
    }

    private async tryRequestMicrophone() {
        this.logger?.debug("Requesting microphone capture")
        try {
            const track = await this.capture.acquire()
            if (track) this.base.setTrack(track)
        } catch (e) {
            this.logger?.debug(`Failed to acquire microphone: ${e}`)
            showNotification("Microphone access failed. Check permission and try again.")
            return
        }
    }

    isLive(): boolean { return this.capture.isLive() }
    setAllowed(allowed: boolean): void { this.capture.setAllowed(allowed) }

    cleanup(): void {
        this.capture.dispose()
        this.base.cleanup()
    }

    onUserInteraction() {
        this.tryRequestMicrophone()

        if ("onUserInteraction" in this.base && typeof this.base.onUserInteraction == "function") {
            return this.base.onUserInteraction(...arguments)
        }
    }

    getBase(): Pipe | null {
        return this.base
    }
}
