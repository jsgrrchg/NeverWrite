import { DEFAULT_AGENT_ID, DEFAULT_MODEL_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";
function restartParams(session) {
    const originalParams = session.creationParams ?? { cwd: session.cwd, mcpServers: [] };
    const currentEffort = session.configOptions.find((option) => option.id === EFFORT_CONFIG_ID)?.currentValue;
    const originalMeta = originalParams._meta;
    const originalOptions = originalMeta?.claudeCode?.options;
    const unmanagedOptions = { ...(originalOptions ?? {}) };
    delete unmanagedOptions.model;
    delete unmanagedOptions.agent;
    delete unmanagedOptions.effort;
    return {
        ...originalParams,
        _meta: {
            ...(originalMeta ?? {}),
            claudeCode: {
                ...(originalMeta?.claudeCode ?? {}),
                options: {
                    ...unmanagedOptions,
                    ...(session.models.currentModelId !== DEFAULT_MODEL_ID
                        ? { model: session.models.currentModelId }
                        : {}),
                    ...(session.currentAgent !== DEFAULT_AGENT_ID ? { agent: session.currentAgent } : {}),
                    ...(typeof currentEffort === "string" && currentEffort !== "default"
                        ? { effort: currentEffort }
                        : {}),
                },
            },
        },
    };
}
/** Replace Claude's private conversation and attach the still-pending ACP turn
 * to it. The host owns provider-specific creation and stream mechanics; this
 * coordinator owns the ordering and state transfer invariants. */
export async function continuePlanInFreshContext(sessionId, oldSession, reset, host, signal) {
    const assertRestartActive = (session) => {
        if (signal?.aborted || (session && host.currentSession(sessionId) !== session)) {
            throw new Error("Clear-context restart aborted");
        }
    };
    assertRestartActive();
    const turn = oldSession.activeTurn;
    if (!turn || turn.settled || host.currentSession(sessionId) !== oldSession) {
        throw new Error("Cannot clear context without an active ACP turn");
    }
    const params = restartParams(oldSession);
    host.closeQueryStream(oldSession);
    const freshSession = await host.restartSession(params, {
        publicSessionId: sessionId,
        permissionMode: reset.mode,
    });
    assertRestartActive(freshSession);
    // Do not consume the reset or mutate the turn until a replacement exists.
    // A failed restart must remain distinguishable from a lost query transport.
    turn.carriedUsage = { ...oldSession.accumulatedUsage };
    turn.carriedModelUsage = { ...oldSession.accumulatedModelUsage };
    oldSession.pendingExitPlanContextReset = undefined;
    if (oldSession.fastModeEnabled !== freshSession.fastModeEnabled) {
        try {
            await host.applyFastMode(freshSession, oldSession.fastModeEnabled);
        }
        catch (error) {
            host.logError("Failed to restore Fast mode after clearing context:", error);
        }
        assertRestartActive(freshSession);
    }
    oldSession.activeTurn = null;
    oldSession.turnQueue = [];
    freshSession.turnQueue = [turn];
    freshSession.contextUsedTokens = 0;
    try {
        await host.publishSessionState(sessionId, reset.mode, freshSession.configOptions);
    }
    catch (error) {
        host.logError("Failed to publish clear-context session state:", error);
    }
    assertRestartActive(freshSession);
    freshSession.input.push(host.continuationMessage(sessionId, reset.plan, turn.promptUuid));
    assertRestartActive(freshSession);
    host.ensureConsumer(freshSession, sessionId);
}
