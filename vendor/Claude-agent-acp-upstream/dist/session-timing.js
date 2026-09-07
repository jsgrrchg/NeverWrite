/** Small phase timer for session lifecycle diagnostics. */
export class SessionTiming {
    logger;
    operation;
    sessionId;
    startedAt;
    phaseStartedAt;
    constructor(logger, operation, sessionId, startedAt = performance.now()) {
        this.logger = logger;
        this.operation = operation;
        this.sessionId = sessionId;
        this.startedAt = startedAt;
        this.phaseStartedAt = startedAt;
    }
    phase(name, detail = "") {
        const finishedAt = performance.now();
        this.logger?.log(`[session/${this.operation}] sessionId=${this.sessionId} phase=${name} durationMs=${Math.round(finishedAt - this.phaseStartedAt)} totalMs=${Math.round(finishedAt - this.startedAt)}${detail}`);
        this.phaseStartedAt = finishedAt;
    }
}
