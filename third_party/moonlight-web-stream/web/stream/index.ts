import { Api, apiEnsureMediaAccess, apiMediaHeartbeat, apiRefreshMediaTicket, apiReleaseMediaAccess, apiWebRTCConfiguration, apiWebRTCOffer, MediaAccess, MediaAccessError, managedStreaming } from "../api"
import { Component } from "../component/index"
import { Settings, TransportType } from "../component/settings_menu"
import { ControlPacket, ControlPacket_Tags, TerminationReason_Tags, VideoFormats } from "../uniffi/moonlight_common_bindings"
import { wait } from "../util"
import { AudioPlayer, AudioPlayerSetup } from "./audio/index"
import { defaultStreamInputConfig, StreamInput } from "./input"
import { Logger, LogMessageInfo } from "./log"
import { gatherPipeInfo, Pipe, Pipeline, pipelineToString, pipeName } from "./pipeline/index"
import { StreamStats } from "./stats"
import { Transport, TransportAudioType, TransportConnectData, TransportOptions, TransportShutdown, TransportVideoType } from "./transport/index"
import { WebSocketTransport } from "./transport/web_socket"
import { WebRTCTransport } from "./transport/webrtc"
import { allVideoCodecs, andVideoCodecs, emptyVideoCodecs, hasAnyCodec } from "./video"
import { VideoRenderer, VideoRendererSetup } from "./video/index"
import { querySupportedDataVideoCodecs, selectVideoPipeline, VideoPipelineOptions } from "./video/pipeline"
import { StreamPermissions } from "../api_bindings"
import { selectAudioPipeline } from "./audio/pipeline"
import { MicrophonePipe, MicrophoneSource } from "./audio/microphone_pipe"
import { showNotification } from "../component/notification"

export type ExecutionEnvironment = {
    main: boolean
    worker: boolean
}

export type StreamCapabilities = {
    touch: boolean
}

export type InfoEvent = CustomEvent<
    { type: "app", appName: string } |
    { type: "connectionComplete", capabilities: StreamCapabilities } |
    { type: "videoReady" } |
    { type: "streamEnded", graceful: boolean, message: string | null } |
    { type: "addDebugLine", line: string, additional?: LogMessageInfo }
>
export type InfoEventListener = (event: InfoEvent) => void

export function getStreamerSize(settings: Settings, viewerScreenSize: [number, number]): [number, number] {
    let width, height
    if (settings.videoSize == "720p") {
        width = 1280
        height = 720
    } else if (settings.videoSize == "1080p") {
        width = 1920
        height = 1080
    } else if (settings.videoSize == "1440p") {
        width = 2560
        height = 1440
    } else if (settings.videoSize == "4k") {
        width = 3840
        height = 2160
    } else if (settings.videoSize == "custom") {
        width = settings.videoSizeCustom.width
        height = settings.videoSizeCustom.height
    } else { // native
        width = viewerScreenSize[0]
        height = viewerScreenSize[1]
    }
    return [width, height]
}

function getVideoCodecHint(settings: Settings): VideoFormats {
    let videoCodecHint = emptyVideoCodecs()
    if (settings.videoCodec == "h264") {
        videoCodecHint.h264 = true
        videoCodecHint.h264High8444 = true
    } else if (settings.videoCodec == "h265") {
        videoCodecHint.h265 = true
        videoCodecHint.h265Main10 = true
        videoCodecHint.h265Rext8444 = true
        videoCodecHint.h265Rext10444 = true
    } else if (settings.videoCodec == "av1") {
        videoCodecHint.av1Main8 = true
        videoCodecHint.av1Main10 = true
        videoCodecHint.av1High8444 = true
        videoCodecHint.av1High10444 = true
    } else if (settings.videoCodec == "auto") {
        videoCodecHint = allVideoCodecs()
    }

    if (isFirefox()) {
        videoCodecHint.av1Main8 = false
        videoCodecHint.av1Main10 = false
    }

    return videoCodecHint
}

function isFirefox(): boolean {
    return navigator.userAgent.includes("Firefox/")
}

const WEBRTC_CONNECT_TIMEOUT_MS = 15000
const FALLBACK_RECONNECT_DELAY_MS = 500

export class Stream implements Component {
    private logger: Logger = new Logger()

    private api: Api

    private hostId: number
    private appId: number

    private permissions: StreamPermissions
    private settings: Settings

    private divElement = document.createElement("div")
    private eventTarget = new EventTarget()

    private transportOverride: TransportType | null = null
    private stopped = false

    private videoRenderer: VideoRenderer | null = null
    private audioPlayer: AudioPlayer | null = null
    private microphoneListener: MicrophoneSource | null = null

    private input: StreamInput
    private stats: StreamStats

    private streamerSize: [number, number]
    private mediaAccess: MediaAccess | null = null
    private mediaHeartbeatTimer: number | null = null

    constructor(api: Api, hostId: number, appId: number, settings: Settings, viewerScreenSize: [number, number], permissions: StreamPermissions) {
        this.logger.addInfoListener((info, type) => {
            this.debugLog(info, { type: type ?? undefined })
        })

        this.api = api

        this.hostId = hostId
        this.appId = appId

        this.permissions = permissions
        this.settings = settings

        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Stream Input
        const streamInputConfig = defaultStreamInputConfig()
        Object.assign(streamInputConfig, {
            mouseMode: this.settings.mouseMode,
            mouseScrollMode: this.settings.mouseScrollMode,
            touchMode: this.settings.touchMode,
            localCursorSensitivity: this.settings.localCursorSensitivity,
            controllerConfig: this.settings.controllerConfig
        })
        this.input = new StreamInput(streamInputConfig)

        // Stream Stats
        this.stats = new StreamStats(this.logger)

        this.startConnection()
    }

    private debugLog(message: string, additional?: LogMessageInfo) {
        for (const line of message.split("\n")) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "addDebugLine", line, additional }
            })

            this.eventTarget.dispatchEvent(event)
        }
    }

    async startConnection() {
        this.debugLog(`Permissions: ${JSON.stringify(this.permissions)}`)
        let retryDelay = 1000
        while (!this.stopped) {
            const desiredTransport = this.transportOverride ?? this.settings.dataTransport
            this.debugLog(`Using transport: ${desiredTransport}`)

            let shutdownReason: TransportShutdown | null = null
            try {
                if (desiredTransport == "auto") {
                    shutdownReason = await this.tryWebRTCTransport()
                    if (shutdownReason == "failednoconnect") {
                        this.debugLog("Failed to establish WebRTC connection. Falling back to Web Socket transport.", { type: "ifErrorDescription" })
                        shutdownReason = await this.tryWebSocketTransport()
                    }
                } else if (desiredTransport == "webrtc") {
                    shutdownReason = await this.tryWebRTCTransport()
                } else if (desiredTransport == "websocket") {
                    shutdownReason = await this.tryWebSocketTransport()
                }
            } catch (error) {
                this.debugLog(`Stream transport failed: ${error}`)
                await this.transport?.close()
                this.transport = null
                shutdownReason = "failednoconnect"
            } finally {
                this.cleanupMicrophone()
            }

            if (this.stopped || shutdownReason == "disconnect") {
                await this.releaseMediaAccess()
                return
            }
            this.debugLog("Stream disconnected; reconnecting", { type: "ifErrorDescription" })
            await wait(retryDelay)
            retryDelay = Math.min(retryDelay * 2, 30000)
        }
    }

    private transport: Transport | null = null

    private setTransport(transport: Transport) {
        if (this.transport) {
            this.debugLog("Closing old transport")
            this.transport.close()
        }
        this.debugLog("Setting new transport")

        this.transport = transport

        this.input.setControlStream(this.transport.controlStream)
        this.stats.setTransport(this.transport)
    }

    private async createTransportOptions(): Promise<TransportOptions | null> {
        const codecHint = getVideoCodecHint(this.settings)

        const dataCodecs = await this.queryDataVideoCodecs()

        if (!hasAnyCodec(codecHint)) {
            this.debugLog("Couldn't find any supported video format. Change the codec option to H264 in the settings if you're unsure which codecs are supported.", { type: "fatalDescription" })
            return null
        }

        return {
            hostId: this.hostId,
            appId: this.appId,
            width: this.streamerSize[0],
            height: this.streamerSize[1],
            fps: this.settings.fps,
            bitrate: this.settings.bitrate,
            hdr: this.settings.hdr,
            localAudioPlayMode: this.settings.playAudioLocal,
            microphone: this.settings.microphone,
            supportedCodecs: dataCodecs,
            preferredCodecs: codecHint,
        }
    }

    private async tryWebRTCTransport(): Promise<TransportShutdown> {
        if (!this.permissions.allow_transport_webrtc) {
            this.debugLog("Not trying WebRTC transport because permissions disallow it")
            return "failednoconnect"
        }

        this.debugLog("Trying WebRTC transport")

        let mediaAccess: MediaAccess | null = null
        try {
            mediaAccess = this.mediaAccess
            if (mediaAccess) await apiRefreshMediaTicket(mediaAccess)
            else mediaAccess = await apiEnsureMediaAccess(this.api, this.hostId, this.appId)
            this.mediaAccess = mediaAccess
            this.startMediaHeartbeat()
            if (this.stopped) {
                this.cleanupMicrophone()
                return "disconnect"
            }
        } catch (error) {
            this.debugLog(`Media control admission failed: ${error}`)
            if (this.mediaAccess && !(error instanceof MediaAccessError && (error.status === 401 || error.status === 410))) {
                return "failednoconnect"
            }
            return "disconnect"
        }

        // Get configuration
        let config: Awaited<ReturnType<typeof apiWebRTCConfiguration>>
        try {
            config = await apiWebRTCConfiguration(this.api)
        } catch (error) {
            this.debugLog(`WebRTC configuration failed: ${error}`)
            this.cleanupMicrophone()
            return "failednoconnect"
        }

        if (this.stopped) {
            this.cleanupMicrophone()
            return "disconnect"
        }
        this.debugLog("Received WebRTC Config, Creating Transport")

        // Create transport
        const transport = new WebRTCTransport(
            this.api,
            {
                iceServers: config.iceServers,
            },
            this.logger
        )
        const mediaTicket = mediaAccess?.ticket ?? null
        transport.controlStream.onreceive = this.boundReceivePacket

        const onConnect = new Promise<TransportConnectData>(resolve => {
            transport.onconnect = resolve
        })
        const onClose = new Promise<TransportShutdown>(resolve => {
            transport.onclose = resolve
        })

        const options = await this.createTransportOptions()
        if (!options) {
            await transport.close()
            this.cleanupMicrophone()
            return "failednoconnect"
        }

        try {
            // Create offer
            const offer = await transport.createOffer(options)

            // Send Request
            this.debugLog("Sending Offer and waiting for Answer")
            const answer = await apiWebRTCOffer(this.api, offer, mediaTicket)
            this.debugLog("Got Response")

            // Apply answer
            await transport.setAnswer(answer)
        } catch (error) {
            this.debugLog(`failed to connect using webrtc because ${error}`)

            await transport.close()
            this.cleanupMicrophone()
            return "failednoconnect"
        }

        if (this.stopped) {
            await transport.close()
            this.cleanupMicrophone()
            return "disconnect"
        }
        // Set Transport
        this.setTransport(transport)

        // Wait for negotiation, but don't let a stuck ICE check block fallback forever.
        const onTimeout: Promise<TransportShutdown> =
            wait(WEBRTC_CONNECT_TIMEOUT_MS)
                .then(() => "failednoconnect")

        const connectData: TransportShutdown | TransportConnectData = await Promise.race([
            onConnect,
            onClose,
            onTimeout,
        ])
        if (typeof connectData == "string") {
            this.debugLog(`webrtc connection failed: ${connectData}`)
            await transport.close()
            this.cleanupMicrophone()
            // connection failed
            return connectData
        }

        // -- Connection successful
        await this.onConnect(connectData)
        this.startMediaHeartbeat()

        const shutdown = await onClose
        this.cleanupMicrophone()
        return shutdown
    }

    private startMediaHeartbeat() {
        if (!this.mediaAccess || this.mediaHeartbeatTimer != null) return
        let pending = false
        const send = async () => {
            if (!this.mediaAccess || pending) return
            pending = true
            try {
                await apiMediaHeartbeat(this.mediaAccess, this.settings.microphone, this.microphoneListener?.isLive() ?? false)
            } catch (error) {
                this.debugLog(`Media heartbeat failed: ${error}`)
                if (error instanceof MediaAccessError && (error.status === 401 || error.status === 410)) await this.stop()
            } finally { pending = false }
        }
        send()
        this.mediaHeartbeatTimer = window.setInterval(send, 5000)
    }

    private async releaseMediaAccess() {
        this.cleanupMicrophone()
        if (this.mediaHeartbeatTimer != null) {
            window.clearInterval(this.mediaHeartbeatTimer)
            this.mediaHeartbeatTimer = null
        }
        if (!this.mediaAccess) return
        const access = this.mediaAccess
        this.mediaAccess = null
        try { await apiReleaseMediaAccess(access) } catch (error) { this.debugLog(`Media disconnect failed: ${error}`) }
    }

    private cleanupMicrophone() {
        this.microphoneListener?.cleanup()
        this.microphoneListener = null
    }
    private async tryWebSocketTransport(): Promise<TransportShutdown | null> {
        // A signed media ticket is an explicit authorization for the WebRTC
        // gateway. Do not silently downgrade to the legacy WebSocket path,
        // which cannot carry the ticket header and would bypass admission.
        const mediaQuery = new URLSearchParams(window.location.search)
        if (managedStreaming() || mediaQuery.has("mediaTicket") || mediaQuery.has("mediaControlUrl")) {
            this.debugLog("Not trying WebSocket transport because a media ticket requires WebRTC admission")
            return "failednoconnect"
        }
        if (!this.permissions.allow_transport_websockets) {
            this.debugLog("Not trying WebSocket transport becaues permissions disallow it")
            return null
        }

        this.debugLog("Trying Web Socket transport")

        const options = await this.createTransportOptions()
        if (!options) {
            return null
        }

        const transport = new WebSocketTransport(this.api, this.logger)

        // Add listeners
        transport.controlStream.onreceive = this.boundReceivePacket

        const onConnect = new Promise<TransportConnectData>(resolve => {
            transport.onconnect = resolve
        })
        const onClose = new Promise<TransportShutdown>(resolve => {
            transport.onclose = resolve
        })

        // Start stream
        await transport.startStream(options)

        this.setTransport(transport)

        const connectData = await Promise.race([
            onConnect,
            onClose,
        ])

        if (typeof connectData == "string") {
            this.debugLog(`web socket connection failed: ${connectData}`)
            await transport.close()
            // connection failed
            return connectData
        }

        // -- Connection successful
        await this.onConnect(connectData)

        return await onClose
    }

    private async onConnect(connectData: TransportConnectData) {
        this.logger.debug("connected successfully, creating video and audio pipelines")

        // Dispatch app event
        let event: InfoEvent = new CustomEvent("stream-info", {
            detail: {
                type: "app", appName: connectData.appName
            }
        })
        this.eventTarget.dispatchEvent(event)

        // Set input
        this.input.onStreamStart(connectData.capabilities, [connectData.videoSetup.width, connectData.videoSetup.height])

        if (this.settings.microphone && !connectData.microphoneType) {
            const micUnsupportedMessage = "Microphone is not supported by the host or the data transport option"
            this.logger.debug(micUnsupportedMessage)
            showNotification(micUnsupportedMessage)
        }

        // Create pipelines
        await this.createPipelines(connectData)

        event = new CustomEvent("stream-info", {
            detail: {
                type: "connectionComplete", capabilities: {
                    // TODO
                    touch: true
                }
            }
        })
        this.eventTarget.dispatchEvent(event)
    }

    private async createPipelines(connectData: TransportConnectData): Promise<void> {
        // Print supported pipes
        const pipesInfo = await gatherPipeInfo()

        this.logger.debug(`Supported Pipes: {`)
        let isFirst = true
        for (const [pipe, info] of pipesInfo) {
            this.logger.debug(`${isFirst ? "" : ","}"${pipeName(pipe)}": ${JSON.stringify(info)}`)
            isFirst = false
        }
        this.logger.debug(`}`)

        const codecSupport = emptyVideoCodecs()
        codecSupport[connectData.videoSetup.codec] = true

        // Create pipelines
        const [gotVideoRenderer, _gotAudioPlayer, _gotMicrophone] = await Promise.all([
            this.createVideoRenderer(connectData.videoType, connectData.videoSetup),
            this.createAudioPlayer(connectData.audioType, connectData.audioSetup),
            this.configureMicrophone(connectData.microphoneType),
        ])

        const videoPipelineName = `${connectData.videoType} (transport) -> ${this.videoRenderer?.implementationName} (renderer)`
        this.debugLog(`Using video pipeline: ${videoPipelineName}`)

        const audioPipelineName = `${connectData.audioType} (transport) -> ${this.audioPlayer?.implementationName} (player)`
        this.debugLog(`Using audio pipeline: ${audioPipelineName}`)

        if (!gotVideoRenderer) {
            this.logger.debug("Failed to start stream because no compatible video renderer was found", { type: "fatalDescription" })
            // TODO: make this error cleaner
            throw "error"
        }

        this.stats.setVideoPipeline(videoPipelineName, this.videoRenderer)
        this.stats.setAudioPipeline(audioPipelineName, this.audioPlayer)
    }

    private async queryDataVideoCodecs(): Promise<VideoFormats> {
        const codecHint = getVideoCodecHint(this.settings)

        const videoSettings: VideoPipelineOptions = {
            supportedVideoCodecs: codecHint,
            canvasRenderer: this.settings.canvasRenderer,
            forceVideoElementRenderer: this.settings.forceVideoElementRenderer,
            canvasVsync: this.settings.canvasVsync
        }

        const codecs = await querySupportedDataVideoCodecs(videoSettings, this.logger)
        if (!codecs) {
            this.logger.debug("failed to query video pipelines for information! Disabling high codecs. This could lead to no video being visible!")
            const baseCodecs = {
                h264: true,
                h264High8444: true,
                h265: true,
                h265Main10: true,
                h265Rext8444: true,
                h265Rext10444: true,
                av1Main8: true,
                av1Main10: true,
                av1High8444: true,
                av1High10444: true
            }

            videoSettings.supportedVideoCodecs = andVideoCodecs(codecHint, baseCodecs)
        }

        return codecs
    }
    private async createVideoRenderer(videoType: TransportVideoType, videoSetup: VideoRendererSetup): Promise<boolean> {
        if (this.videoRenderer) {
            this.debugLog("Found an old video renderer -> cleaning it up")

            this.videoRenderer.unmount(this.divElement)
            this.videoRenderer.cleanup()
            this.videoRenderer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup video without transport")
            return false
        }

        const supportedVideoCodecs = emptyVideoCodecs()
        supportedVideoCodecs[videoSetup.codec] = true

        const videoSettings: VideoPipelineOptions = {
            supportedVideoCodecs,
            canvasRenderer: this.settings.canvasRenderer,
            forceVideoElementRenderer: this.settings.forceVideoElementRenderer,
            canvasVsync: this.settings.canvasVsync
        }

        const pipeline = await selectVideoPipeline(videoType, videoSettings, this.logger)
        if (!pipeline) {
            return false
        }
        this.logger.debug(`Trying to build video pipeline ${pipelineToString(pipeline)}`)

        this.videoRenderer = await this.transport.connectVideoPipeline(pipeline) as VideoRenderer

        this.videoRenderer.mount(this.divElement)
        await this.videoRenderer.setup(videoSetup)

        return true
    }
    private async createAudioPlayer(audioType: TransportAudioType, audioSetup: AudioPlayerSetup): Promise<boolean> {
        if (this.audioPlayer) {
            this.debugLog("Found an old audio player -> cleaning it up")

            this.audioPlayer.unmount(this.divElement)
            this.audioPlayer.cleanup()
            this.audioPlayer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup audio without transport")
            return false
        }

        const pipeline = await selectAudioPipeline(audioType, {}, this.logger)
        if (!pipeline) {
            return false
        }
        this.logger.debug(`Trying to build audio pipeline ${pipelineToString(pipeline)}`)

        this.audioPlayer = await this.transport.connectAudioPipeline(pipeline) as AudioPlayer

        this.audioPlayer.mount(this.divElement)
        await this.audioPlayer.setup(audioSetup)

        return true
    }
    private async configureMicrophone(type: string | null) {
        if (!type) {
            return
        }

        if (!this.transport) {
            this.debugLog("Failed to setup microphone without transport")
            return
        }

        // TODO: make this more dynamic
        let pipeline: Pipeline | null = null
        if (type == "audiotrack") {
            pipeline = { pipes: [MicrophonePipe] }
        }
        if (!pipeline) {
            this.debugLog("Failed to setup microphone because no pipeline exists")
            return
        }

        const transport = this.transport
        const source = await transport.connectMicrophonePipeline(pipeline) as MicrophoneSource | null
        if (this.stopped || this.transport !== transport) { source?.cleanup(); return }
        this.microphoneListener?.cleanup()
        this.microphoneListener = source
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }

    getVideoRenderer(): VideoRenderer | null {
        return this.videoRenderer
    }
    getAudioPlayer(): AudioPlayer | null {
        return this.audioPlayer
    }
    getMicrophoneListener(): Pipe | null {
        return this.microphoneListener
    }

    async stop(): Promise<boolean> {
        this.stopped = true
        this.microphoneListener?.cleanup()
        this.microphoneListener = null
        // Stop transport
        try {
            await this.transport?.close()
        } finally {
            this.transport = null
            await this.releaseMediaAccess()
        }

        return true
    }

    private boundReceivePacket = this.onReceivePacket.bind(this)
    private async onReceivePacket(packet: ControlPacket) {
        switch (packet.tag) {
            case ControlPacket_Tags.ServerTermination: {
                const reason = packet.inner.reason
                const graceful = reason.tag == TerminationReason_Tags.Long && reason.inner[0] == 0x80030023

                // close the transport
                this.stop()

                let message = null
                if (graceful) {
                    message = "The host ended the stream gracefully."
                } else {
                    message = `The host ended the stream (code 0x${reason.inner[0].toString(16)})`
                }

                const event: InfoEvent = new CustomEvent("stream-info", {
                    detail: { type: "streamEnded", graceful, message }
                })

                this.eventTarget.dispatchEvent(event)
                return
            }
            case ControlPacket_Tags.HdrMode:
                if (this.videoRenderer && this.videoRenderer.setHdrMode) {
                    this.videoRenderer?.setHdrMode(packet.inner.enabled, packet.inner.sunshine)
                }
                break
        }

        this.input.onReceivePacket(packet)
    }

    // -- Class Api
    addInfoListener(listener: InfoEventListener) {
        this.eventTarget.addEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }
    removeInfoListener(listener: InfoEventListener) {
        this.eventTarget.removeEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }

    getInput(): StreamInput {
        return this.input
    }
    getStats(): StreamStats {
        return this.stats
    }

    getStreamerSize(): [number, number] {
        return this.streamerSize
    }
}
