import { SessionNotification } from "@agentclientprotocol/sdk";
import { ContextCompactionMetadata } from "./context-compaction-meta.js";
type CompactionStatus = "completed" | "failed";
type CompactionState = {
    toolCallId: string;
    terminalStatus?: CompactionStatus;
    heartbeatSent: boolean;
};
type SendUpdate = (notification: SessionNotification) => Promise<void>;
/**
 * Translates Claude's compaction signals into one idempotent ACP tool lifecycle.
 *
 * The SDK can duplicate terminal compact_result messages and can omit the
 * opening status on replay. State therefore lives until the owning turn's
 * result (or abort), while a new compacting status after a terminal outcome
 * starts a fresh lifecycle.
 */
export declare class ContextCompactionLifecycle {
    private readonly sendUpdate;
    private activeCompaction;
    private outputDelivered;
    private duplicateErrorOutput;
    constructor(sendUpdate: SendUpdate);
    get hasDeliveredOutput(): boolean;
    reset(): void;
    /**
     * Claude also emits a failed manual compaction's error as local-command
     * stdout. Consume that one duplicate after the tool lifecycle carried it,
     * without hiding unrelated command output.
     */
    consumeDuplicateErrorOutput(content: string): boolean;
    start(sessionId: string, toolCallId: string): Promise<CompactionState>;
    heartbeat(sessionId: string, fallbackId: string): Promise<void>;
    finish(sessionId: string, fallbackId: string, status: CompactionStatus, metadata?: Omit<ContextCompactionMetadata, "version">, enrichTerminal?: boolean): Promise<void>;
}
export declare function contextCompactionMetadataFromBoundary(compactMetadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens?: number;
    duration_ms?: number;
}): Omit<ContextCompactionMetadata, "version">;
export {};
//# sourceMappingURL=context-compaction.d.ts.map