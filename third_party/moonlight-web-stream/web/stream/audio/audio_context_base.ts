import { Logger } from "../log"
import { Pipe } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { StatValue } from "../stats"
import { AudioPlayerSetup, NodeAudioPlayer } from "./index"

export abstract class AudioContextBasePipe implements NodeAudioPlayer {

    readonly implementationName: string

    private logger: Logger | null = null

    private base: Pipe | null
    private audioContext: AudioContext | null = null

    constructor(implementationName: string, base: Pipe | null, logger?: Logger) {
        this.logger = logger ?? null

        this.implementationName = implementationName
        this.base = base
    }

    protected addPipePassthrough() {
        addPipePassthrough(this, ["mount", "unmount"])
    }

    setup(setup: AudioPlayerSetup) {
        try {
            this.audioContext = new AudioContext({
                latencyHint: "interactive",
                sampleRate: setup.sampleRate
            })
        } catch (e: any) {
            this.logger?.debug(`Failed to setup audio node with latency hint "interactive". Trying to setup without latency hint. ${"toString" in e && typeof e.toString == "function" ? e.toString() : e}`)
        }

        if (!this.audioContext) {
            this.audioContext = new AudioContext({
                sampleRate: setup.sampleRate
            })
        }

        if (this.base && "setup" in this.base && typeof this.base.setup == "function") {
            return this.base.setup(...arguments)
        }
    }
    cleanup(): void {
        const context = this.audioContext
        this.audioContext = null
        if (context && context.state !== "closed") {
            void context.close().catch(error => this.logger?.debug(`Failed to close audio context: ${error}`))
        }
        if (this.base && "cleanup" in this.base && typeof this.base.cleanup === "function") {
            this.base.cleanup()
        }
    }

    onUserInteraction(): void {
        const context = this.audioContext
        if (context && context.state !== "running" && context.state !== "closed") {
            // Keep resume and the downstream media element play in this same
            // user gesture; awaiting one first can lose transient activation.
            void context.resume().catch(error => {
                if (this.audioContext === context) this.logger?.debug(`Audio context resume failed: ${error}`)
            })
        }
        if (this.base && "onUserInteraction" in this.base && typeof this.base.onUserInteraction == "function") {
            return this.base.onUserInteraction(...arguments)
        }
    }

    abstract setSource(source: AudioNode): void

    async reportStats(statsObject: Record<string, StatValue>): Promise<void> {
        // Both values are in secs -> we convert into ms
        if (this.audioContext?.baseLatency) {
            statsObject.audioContextBaseLatencyMs = this.audioContext.baseLatency * 1000
        } else {
            statsObject.audioContextBaseLatencyMs = "null"
        }
        if (this.audioContext?.outputLatency) {
            statsObject.audioContextOutputLatencyMs = this.audioContext.outputLatency * 1000
        } else {
            statsObject.audioContextOutputLatencyMs = "null"
        }

        if (this.base && "reportStats" in this.base && typeof this.base.reportStats == "function") {
            // @ts-ignore
            return await this.base.reportStats(...arguments)
        }
    }

    getAudioContext(): AudioContext {
        if (!this.audioContext) {
            this.logger?.debug("Failed to get audio context", { type: "fatal" })
            throw "Failed to get audio context."
        }
        return this.audioContext
    }

    getBase(): Pipe | null {
        return this.base
    }

    // -- Only definition look addPipePassthrough
    mount(_parent: HTMLElement): void { }
    unmount(_parent: HTMLElement): void { }
}
