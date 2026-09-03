import { continuePlanInFreshContext, } from "./clear-context-coordinator.js";
import { parseToolResultMeta } from "./tool-result-meta.js";
export function acceptedPlanToolResult(notification, toolUseId) {
    const update = notification.update;
    if (!toolUseId ||
        update.sessionUpdate !== "tool_call_update" ||
        update.toolCallId !== toolUseId) {
        return notification;
    }
    const completed = { ...update };
    delete completed.rawOutput;
    delete completed.content;
    return { ...notification, update: { ...completed, status: "completed" } };
}
function containsToolResultFor(content, toolUseId) {
    return (Array.isArray(content) &&
        content.some((block) => typeof block === "object" &&
            block !== null &&
            block.type === "tool_result" &&
            block.tool_use_id === toolUseId));
}
function rejectedExitPlanToolUseId(content, toolUseCache, rawToolResultMeta) {
    if (!Array.isArray(content))
        return undefined;
    const toolResultMeta = parseToolResultMeta(rawToolResultMeta);
    if (!toolResultMeta)
        return undefined;
    for (const block of content) {
        if (typeof block !== "object" || block === null)
            continue;
        const { type, tool_use_id: toolUseId, is_error: isError } = block;
        if (type === "tool_result" &&
            typeof toolUseId === "string" &&
            isError === true &&
            toolResultMeta.get(toolUseId)?.nonExecutionKind === "user-rejected" &&
            toolUseCache[toolUseId]?.name === "ExitPlanMode") {
            return toolUseId;
        }
    }
    return undefined;
}
/** Reconcile an SDK user message with the two pending ExitPlanMode lanes and
 * return the accepted plan tool id whose rendered update must be completed. */
export function observeExitPlanToolResults(message, content, state) {
    if (message.type !== "user")
        return undefined;
    const rejectedToolUseId = rejectedExitPlanToolUseId(content, state.toolUseCache, message.tool_result_meta);
    if (rejectedToolUseId) {
        // The stream is authoritative: resumed queries can lose the short-lived
        // marker installed by canUseTool, while metadata preserves correlation.
        state.pendingExitPlanModeInterruption = {
            toolUseId: rejectedToolUseId,
            toolResultSeen: true,
        };
    }
    const pendingInterruption = state.pendingExitPlanModeInterruption;
    if (pendingInterruption && containsToolResultFor(content, pendingInterruption.toolUseId)) {
        pendingInterruption.toolResultSeen = true;
    }
    const pendingReset = state.pendingExitPlanContextReset;
    return pendingReset && containsToolResultFor(content, pendingReset.toolUseId)
        ? pendingReset.toolUseId
        : undefined;
}
export function executionDiagnostic(message) {
    if (message.subtype === "success") {
        return message.result.startsWith("[ede_diagnostic]") ? message.result : undefined;
    }
    return message.errors.find((error) => error.startsWith("[ede_diagnostic]"));
}
/** Claude wraps a rejected ExitPlanMode explanation in a Markdown code fence.
 * Strip exactly one complete outer fence for that tool only. */
export function exitPlanModeRawOutput(toolName, content) {
    if (toolName !== "ExitPlanMode" || typeof content !== "string") {
        return content;
    }
    const fenced = /^\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(content);
    return fenced?.[1] ?? content;
}
/** Owns the lifetime of accepted-plan context replacements. In particular, a
 * session cancellation invalidates an in-progress async restart so a late
 * restartSession result cannot recreate a closed public session. */
export class ExitPlanCoordinator {
    host;
    restarts = new Map();
    constructor(host) {
        this.host = host;
    }
    cancel(sessionId) {
        this.restarts.get(sessionId)?.abort();
    }
    async restart(sessionId, oldSession, reset) {
        this.cancel(sessionId);
        const controller = new AbortController();
        this.restarts.set(sessionId, controller);
        try {
            const clearContextHost = {
                ...this.host,
                publishSessionState: async (id, mode, configOptions) => {
                    await this.host.sessionUpdate({
                        sessionId: id,
                        update: { sessionUpdate: "current_mode_update", currentModeId: mode },
                    });
                    await this.host.sessionUpdate({
                        sessionId: id,
                        update: { sessionUpdate: "config_option_update", configOptions },
                    });
                },
                continuationMessage: (id, plan, promptUuid) => ({
                    type: "user",
                    message: {
                        role: "user",
                        content: [{ type: "text", text: `Implement the following plan:\n\n${plan}` }],
                    },
                    session_id: id,
                    parent_tool_use_id: null,
                    origin: { kind: "human" },
                    uuid: promptUuid,
                }),
            };
            await continuePlanInFreshContext(sessionId, oldSession, reset, clearContextHost, controller.signal);
        }
        catch (error) {
            const currentSession = this.host.currentSession(sessionId);
            const replacement = currentSession !== oldSession ? currentSession : undefined;
            if (replacement)
                this.host.destroyReplacement(sessionId, replacement);
            const turn = replacement?.activeTurn ?? oldSession.activeTurn;
            if (turn && !turn.settled) {
                const turnSession = replacement?.activeTurn === turn ? replacement : oldSession;
                if (controller.signal.aborted) {
                    this.host.settleCancelledTurn(oldSession, turnSession, turn);
                }
                else {
                    // A provider/session-creation failure is turn-scoped. Settling it
                    // here keeps it out of the query consumer's transport-loss catch.
                    this.host.settleFailedTurn(turnSession, turn, error);
                }
                oldSession.activeTurn = null;
                oldSession.turnQueue = (oldSession.turnQueue ?? []).filter((queued) => queued !== turn);
                if (replacement) {
                    replacement.activeTurn = null;
                    replacement.turnQueue = (replacement.turnQueue ?? []).filter((queued) => queued !== turn);
                }
            }
            oldSession.pendingExitPlanContextReset = undefined;
        }
        finally {
            if (this.restarts.get(sessionId) === controller) {
                this.restarts.delete(sessionId);
            }
        }
    }
}
