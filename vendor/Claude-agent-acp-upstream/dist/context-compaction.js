import { createContextCompactionMeta, } from "./context-compaction-meta.js";
/**
 * Translates Claude's compaction signals into one idempotent ACP tool lifecycle.
 *
 * The SDK can duplicate terminal compact_result messages and can omit the
 * opening status on replay. State therefore lives until the owning turn's
 * result (or abort), while a new compacting status after a terminal outcome
 * starts a fresh lifecycle.
 */
export class ContextCompactionLifecycle {
    sendUpdate;
    activeCompaction;
    outputDelivered = false;
    duplicateErrorOutput;
    constructor(sendUpdate) {
        this.sendUpdate = sendUpdate;
    }
    get hasDeliveredOutput() {
        return this.outputDelivered;
    }
    reset() {
        this.activeCompaction = undefined;
        this.outputDelivered = false;
        this.duplicateErrorOutput = undefined;
    }
    /**
     * Claude also emits a failed manual compaction's error as local-command
     * stdout. Consume that one duplicate after the tool lifecycle carried it,
     * without hiding unrelated command output.
     */
    consumeDuplicateErrorOutput(content) {
        if (this.duplicateErrorOutput === undefined ||
            content.trim() !== this.duplicateErrorOutput.trim()) {
            return false;
        }
        this.duplicateErrorOutput = undefined;
        return true;
    }
    async start(sessionId, toolCallId) {
        if (this.activeCompaction && !this.activeCompaction.terminalStatus) {
            return this.activeCompaction;
        }
        this.activeCompaction = { toolCallId, heartbeatSent: false };
        this.outputDelivered = true;
        await this.sendUpdate({
            sessionId,
            update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: "Compact conversation",
                kind: "think",
                status: "in_progress",
                _meta: compactionToolMeta(),
            },
        });
        return this.activeCompaction;
    }
    async heartbeat(sessionId, fallbackId) {
        const state = this.activeCompaction ?? (await this.start(sessionId, fallbackId));
        if (state.terminalStatus || state.heartbeatSent)
            return;
        state.heartbeatSent = true;
        await this.sendUpdate({
            sessionId,
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: state.toolCallId,
                status: "in_progress",
                _meta: compactionToolMeta(),
            },
        });
    }
    async finish(sessionId, fallbackId, status, metadata = {}, enrichTerminal = false) {
        const rawOutput = Object.keys(metadata).length > 0 ? metadata : undefined;
        if (!this.activeCompaction) {
            this.activeCompaction = {
                toolCallId: fallbackId,
                heartbeatSent: false,
                terminalStatus: status,
            };
            this.outputDelivered = true;
            if (status === "failed" && metadata.error) {
                this.duplicateErrorOutput = metadata.error;
            }
            await this.sendUpdate({
                sessionId,
                update: {
                    sessionUpdate: "tool_call",
                    toolCallId: fallbackId,
                    title: "Compact conversation",
                    kind: "think",
                    status,
                    ...(status === "failed" && metadata.error
                        ? { content: [compactionErrorContent(metadata.error)] }
                        : {}),
                    ...(rawOutput ? { rawOutput } : {}),
                    _meta: compactionToolMeta(metadata),
                },
            });
            return;
        }
        const state = this.activeCompaction;
        if (state.terminalStatus && !enrichTerminal)
            return;
        const firstTerminal = state.terminalStatus === undefined;
        if (firstTerminal)
            state.terminalStatus = status;
        if (status === "failed" && metadata.error) {
            this.duplicateErrorOutput = metadata.error;
        }
        await this.sendUpdate({
            sessionId,
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: state.toolCallId,
                ...(firstTerminal ? { status } : {}),
                ...(status === "failed" && metadata.error
                    ? { content: [compactionErrorContent(metadata.error)] }
                    : {}),
                ...(rawOutput ? { rawOutput } : {}),
                _meta: compactionToolMeta(metadata),
            },
        });
    }
}
export function contextCompactionMetadataFromBoundary(compactMetadata) {
    return {
        trigger: compactMetadata.trigger === "auto" ? "automatic" : "manual",
        preTokens: compactMetadata.pre_tokens,
        ...(compactMetadata.post_tokens !== undefined
            ? { postTokens: compactMetadata.post_tokens }
            : {}),
        ...(compactMetadata.duration_ms !== undefined
            ? { durationMs: compactMetadata.duration_ms }
            : {}),
    };
}
function compactionToolMeta(metadata = {}) {
    return {
        ...createContextCompactionMeta(metadata),
        claudeCode: { toolName: "compact" },
    };
}
function compactionErrorContent(error) {
    return {
        type: "content",
        content: {
            type: "text",
            text: `Compaction failed: ${error}`,
        },
    };
}
