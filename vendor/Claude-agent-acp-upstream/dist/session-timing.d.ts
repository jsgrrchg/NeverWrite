type TimingLogger = {
    log: (...args: unknown[]) => void;
};
/** Small phase timer for session lifecycle diagnostics. */
export declare class SessionTiming {
    private readonly logger;
    private readonly operation;
    private readonly sessionId;
    private readonly startedAt;
    private phaseStartedAt;
    constructor(logger: TimingLogger | undefined, operation: string, sessionId: string, startedAt?: number);
    phase(name: string, detail?: string): void;
}
export {};
//# sourceMappingURL=session-timing.d.ts.map