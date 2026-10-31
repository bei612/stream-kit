/** Owns generated media and permits only one outstanding browser write. */
export class RealtimeTrackWriter<T extends { close(): void }> {
    private disposed = false
    private pending: { sample: T, closed: boolean } | null = null

    constructor(private writer: WritableStreamDefaultWriter<T>, private track: MediaStreamTrack,
        private onError: (error: unknown) => void = () => {}) {
        // WritableStream reports failures both on write and on closed.
        void writer.closed.catch(() => {})
    }

    submit(sample: T): void {
        if (this.disposed || this.pending || this.writer.desiredSize === null || this.writer.desiredSize <= 0) {
            sample.close()
            return
        }
        const pending = { sample, closed: false }
        this.pending = pending
        const failed = (error: unknown) => {
            if (!this.disposed) { this.onError(error); this.close() }
        }
        try {
            void this.writer.write(sample).catch(failed).finally(() => {
                this.release(pending)
                if (this.pending === pending) this.pending = null
            })
        } catch (error) {
            failed(error)
            this.release(pending)
            this.pending = null
        }
    }

    private release(pending: { sample: T, closed: boolean }): void {
        if (!pending.closed) { pending.closed = true; pending.sample.close() }
    }

    close(): void {
        if (this.disposed) return
        this.disposed = true
        this.track.stop()
        void this.writer.abort().catch(() => {}).finally(() => this.writer.releaseLock())
        if (this.pending) this.release(this.pending)
    }
}
