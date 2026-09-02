import { RequestError, } from "@agentclientprotocol/sdk";
import { ALLOW_BYPASS } from "./permissions/modes.js";
export const MODE_CONFIG_ID = "mode";
export const AUTO_MODE_FALLBACK = "acceptEdits";
const AUTO_MODE_FALLBACK_NOTICE = "**Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.";
/** Owns session-mode policy and the ACP/SDK synchronization it requires. */
export class SessionModeManager {
    options;
    constructor(options) {
        this.options = options;
    }
    async initialize({ query, requestedMode, currentModelInfo, currentModelId, }) {
        const availableModes = this.buildAvailableModes();
        let effectiveMode = requestedMode;
        let autoModeFallbackWarningPending = false;
        if (effectiveMode === "auto" &&
            currentModelInfo !== undefined &&
            currentModelInfo.supportsAutoMode !== true) {
            this.options.logError(`permissions.defaultMode "auto" is not available for model ` +
                `"${currentModelId}"; falling back to "${AUTO_MODE_FALLBACK}".`);
            effectiveMode = AUTO_MODE_FALLBACK;
            autoModeFallbackWarningPending = true;
            await this.trySyncMode(query, effectiveMode, "Failed to sync clamped permissionMode to SDK:");
        }
        else if (!this.isAvailable(availableModes, effectiveMode)) {
            this.options.logError(`permissions.defaultMode "${effectiveMode}" is not available in ` +
                `this session; falling back to "default".`);
            effectiveMode = "default";
            await this.trySyncMode(query, effectiveMode, "Failed to sync clamped permissionMode to SDK:");
        }
        return {
            modes: { currentModeId: effectiveMode, availableModes },
            autoModeFallbackWarningPending,
        };
    }
    static configOption(modes) {
        return {
            id: MODE_CONFIG_ID,
            name: "Mode",
            description: "Session permission mode",
            category: "mode",
            type: "select",
            currentValue: modes.currentModeId,
            options: modes.availableModes.map((mode) => ({
                value: mode.id,
                name: mode.name,
                description: mode.description,
                _meta: mode._meta,
            })),
        };
    }
    syncConfig(session, mode) {
        session.modes = { ...session.modes, currentModeId: mode };
        session.configOptions = session.configOptions.map((option) => option.id === MODE_CONFIG_ID && typeof option.currentValue === "string"
            ? { ...option, currentValue: mode }
            : option);
    }
    availableModeIds(modes) {
        return modes.availableModes.map((mode) => mode.id);
    }
    effectiveMode(session, requestedMode) {
        return requestedMode === "auto" && this.isAutoUnavailable(session)
            ? AUTO_MODE_FALLBACK
            : requestedMode;
    }
    applyPermissionFallback(session, permissionResult) {
        const fallbackApplied = this.isAutoUnavailable(session) &&
            permissionResult.behavior === "allow" &&
            permissionResult.updatedPermissions?.some((update) => update.type === "setMode" && update.mode === "auto") === true;
        if (!fallbackApplied || permissionResult.behavior !== "allow") {
            return { permissionResult, fallbackApplied: false };
        }
        return {
            permissionResult: {
                ...permissionResult,
                updatedPermissions: permissionResult.updatedPermissions?.map((update) => update.type === "setMode" && update.mode === "auto"
                    ? { ...update, mode: AUTO_MODE_FALLBACK }
                    : update),
            },
            fallbackApplied: true,
        };
    }
    /** Reconcile mode after a model switch. The caller rebuilds config options
     * before publishing the returned state change. */
    async reconcileForModel(session, model) {
        if (session.modes.currentModeId !== "auto" ||
            model === undefined ||
            model.supportsAutoMode === true) {
            return false;
        }
        session.modes = {
            availableModes: session.modes.availableModes,
            currentModeId: AUTO_MODE_FALLBACK,
        };
        await this.trySyncMode(session.query, AUTO_MODE_FALLBACK, `Failed to sync permissionMode to "${AUTO_MODE_FALLBACK}" after model switch invalidated "auto":`);
        return true;
    }
    async selectMode(sessionId, modeId) {
        const session = this.requireOpenSession(sessionId);
        const requestedMode = this.parseMode(modeId);
        if (!this.isAvailable(session.modes.availableModes, requestedMode)) {
            throw new Error(`Mode ${modeId} is not available in this session`);
        }
        const effectiveMode = this.effectiveMode(session, requestedMode);
        try {
            await session.query.setPermissionMode(effectiveMode);
        }
        catch (error) {
            if (error instanceof Error) {
                if (!error.message)
                    error.message = "Invalid Mode";
                throw error;
            }
            // eslint-disable-next-line preserve-caught-error
            throw new Error("Invalid Mode");
        }
        if (effectiveMode !== requestedMode) {
            await this.publishFallbackWarning(sessionId, session);
        }
        return effectiveMode;
    }
    async setSessionMode(params) {
        const effectiveMode = await this.selectMode(params.sessionId, params.modeId);
        if (effectiveMode !== params.modeId) {
            await this.publishCurrent(params.sessionId, effectiveMode);
        }
        await this.options.updateConfigOption(params.sessionId, MODE_CONFIG_ID, effectiveMode);
        return {};
    }
    async publishCurrent(sessionId, mode) {
        await this.options.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "current_mode_update", currentModeId: mode },
        });
    }
    async publishFallbackWarning(sessionId, session) {
        session.autoModeFallbackWarningPending = false;
        if (session.autoModeFallbackWarningShown)
            return;
        session.autoModeFallbackWarningShown = true;
        try {
            await this.options.sessionUpdate({
                sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: AUTO_MODE_FALLBACK_NOTICE },
                },
            });
        }
        catch (error) {
            // The fallback has already been applied; a failed advisory must not turn
            // the successful mode change into a failed request.
            this.options.logError(`Failed to publish Auto mode fallback warning: ${error}`);
        }
    }
    async publishFallbackState(sessionId, session) {
        await this.publishCurrent(sessionId, AUTO_MODE_FALLBACK);
        await this.publishFallbackWarning(sessionId, session);
    }
    requireOpenSession(sessionId) {
        const session = this.options.getSession(sessionId);
        if (!session)
            throw new Error("Session not found");
        if (session.queryClosed) {
            throw RequestError.internalError(undefined, this.options.sessionEndedMessage);
        }
        return session;
    }
    isAutoUnavailable(session, modelId = session.models.currentModelId) {
        const modelInfo = session.modelInfos.find((model) => model.value === modelId);
        return modelInfo !== undefined && modelInfo.supportsAutoMode !== true;
    }
    isAvailable(availableModes, modeId) {
        return availableModes.some((mode) => mode.id === modeId);
    }
    parseMode(modeId) {
        switch (modeId) {
            case "auto":
            case "default":
            case "acceptEdits":
            case "bypassPermissions":
            case "dontAsk":
            case "plan":
                return modeId;
            default:
                throw new Error("Invalid Mode");
        }
    }
    buildAvailableModes() {
        const modes = [
            {
                id: "default",
                name: "Manual",
                description: "Always ask before making changes",
                _meta: { kind: "standard" },
            },
            {
                id: "acceptEdits",
                name: "Accept edits",
                description: "Automatically accept all file edits",
                _meta: { kind: "standard" },
            },
            {
                id: "plan",
                name: "Plan",
                description: "Create a plan before making changes",
                _meta: { kind: "plan" },
            },
            {
                id: "auto",
                name: "Auto",
                description: "Claude handles permission decisions",
                _meta: { kind: "auto_review" },
            },
        ];
        if (ALLOW_BYPASS) {
            modes.push({
                id: "bypassPermissions",
                name: "Bypass permissions",
                description: "Accepts all permissions",
                _meta: { kind: "full_access" },
            });
        }
        return modes;
    }
    async trySyncMode(query, mode, errorMessage) {
        try {
            await query.setPermissionMode(mode);
        }
        catch (error) {
            this.options.logError(errorMessage, error);
        }
    }
}
