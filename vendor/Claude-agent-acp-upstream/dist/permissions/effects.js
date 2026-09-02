import { PERMISSION_OPTION_ID } from "./options.js";
/** Parse the ACP envelope once before dispatching to a tool-specific effect. */
export function parseClaudePermissionSelection(response, toolName) {
    if (response.outcome?.outcome !== "selected")
        throw new Error("Tool use aborted");
    const optionId = response.outcome.optionId;
    const contextResetMode = toolName === "ExitPlanMode" ? exitPlanClearContextMode(optionId) : undefined;
    return { optionId, ...(contextResetMode ? { contextResetMode } : {}) };
}
function allow(context, updatedPermissions, permanent = false) {
    return {
        behavior: "allow",
        updatedInput: context.input,
        ...(updatedPermissions ? { updatedPermissions } : {}),
        toolUseID: context.toolUseID,
        decisionClassification: permanent ? "user_permanent" : "user_temporary",
    };
}
function deny(context, message = "User refused permission to run tool", interrupt = false) {
    return {
        behavior: "deny",
        message,
        ...(interrupt ? { interrupt: true } : {}),
        toolUseID: context.toolUseID,
        decisionClassification: "user_reject",
    };
}
function skillName(input) {
    const value = typeof input.skill === "string" ? input.skill.trim() : "";
    if (!value || value.length > 1_000)
        throw new Error("Invalid Skill permission input");
    return value;
}
function localAllowRuleUpdate(toolName, ruleContent) {
    return [
        {
            type: "addRules",
            rules: [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }],
            behavior: "allow",
            destination: "localSettings",
        },
    ];
}
function webFetchPermissionUpdate(input) {
    if (typeof input.url !== "string")
        throw new Error("Invalid WebFetch permission input");
    let hostname;
    try {
        hostname = new URL(input.url).hostname;
    }
    catch {
        throw new Error("Invalid WebFetch permission input");
    }
    if (!hostname)
        throw new Error("Invalid WebFetch permission input");
    return localAllowRuleUpdate("WebFetch", `domain:${hostname}`);
}
function applySkillSelection(selection, context) {
    switch (selection.optionId) {
        case PERMISSION_OPTION_ID.allowSkillExact: {
            return allow(context, localAllowRuleUpdate("Skill", skillName(context.input)), true);
        }
        case PERMISSION_OPTION_ID.allowSkillPrefix: {
            const skill = skillName(context.input);
            const spaceIndex = skill.indexOf(" ");
            if (spaceIndex <= 0)
                throw new Error("Skill prefix permission requires arguments");
            return allow(context, localAllowRuleUpdate("Skill", `${skill.slice(0, spaceIndex)}:*`), true);
        }
        default:
            return applyCommonSelection(selection, context);
    }
}
function exitPlanMode(optionId) {
    switch (optionId) {
        case PERMISSION_OPTION_ID.exitPlanBypass:
            return "bypassPermissions";
        case PERMISSION_OPTION_ID.exitPlanAuto:
            return "auto";
        case PERMISSION_OPTION_ID.exitPlanAcceptEdits:
            return "acceptEdits";
        case PERMISSION_OPTION_ID.exitPlanDefault:
            return "default";
        default:
            return undefined;
    }
}
export function exitPlanClearContextMode(optionId) {
    switch (optionId) {
        case PERMISSION_OPTION_ID.exitPlanClearAuto:
            return "auto";
        case PERMISSION_OPTION_ID.exitPlanClearBypass:
            return "bypassPermissions";
        case PERMISSION_OPTION_ID.exitPlanClearAcceptEdits:
            return "acceptEdits";
        default:
            return undefined;
    }
}
function applyExitPlanModeSelection(selection, context) {
    if (selection.contextResetMode) {
        // The adapter consumes this interrupt and continues the same ACP turn on a
        // fresh Claude query. Returning allow here would execute ExitPlanMode in
        // the old context before the handoff.
        return deny(context, "User accepted the plan and requested a fresh context", true);
    }
    const mode = exitPlanMode(selection.optionId);
    if (mode) {
        return allow(context, [{ type: "setMode", mode, destination: "session" }], mode !== "default");
    }
    if (selection.optionId === PERMISSION_OPTION_ID.reject) {
        // A regular deny lets Claude continue planning and ask another question.
        // Interrupt stops this ACP turn; the adapter maps Claude's internal
        // diagnostic for that intentional stop back to cancellation.
        return deny(context, "User chose to keep planning", true);
    }
    return applyCommonSelection(selection, context);
}
function applyCommonSelection(selection, context) {
    switch (selection.optionId) {
        case PERMISSION_OPTION_ID.allowOnce:
            return allow(context);
        case PERMISSION_OPTION_ID.allowWithUpdates:
            if (!context.durableChangeSet)
                throw new Error("Invalid durable permission selection");
            return allow(context, context.durableChangeSet.updates, true);
        case PERMISSION_OPTION_ID.reject:
            return deny(context);
        default:
            throw new Error(`Unknown permission option: ${selection.optionId}`);
    }
}
function applyGeneratedDurableSelection(selection, context, updates) {
    if (selection.optionId !== PERMISSION_OPTION_ID.allowWithUpdates) {
        return applyCommonSelection(selection, context);
    }
    return allow(context, updates(), true);
}
/** Apply a parsed selection using the semantics of the tool that produced it. */
export function applyClaudePermissionSelection(selection, context) {
    switch (context.toolName) {
        case "Skill":
            return applySkillSelection(selection, context);
        case "WebFetch":
            return applyGeneratedDurableSelection(selection, context, () => webFetchPermissionUpdate(context.input));
        case "EnterPlanMode":
            return applyCommonSelection(selection, context);
        case "ExitPlanMode":
            return applyExitPlanModeSelection(selection, context);
        case "Read":
        case "Bash":
        case "PowerShell":
        case "Glob":
        case "Grep":
        case "Edit":
        case "Write":
        case "NotebookEdit":
        case "SandboxNetworkAccess":
            return applyCommonSelection(selection, context);
        default:
            if (context.toolName.startsWith("mcp__")) {
                return applyCommonSelection(selection, context);
            }
            return applyGeneratedDurableSelection(selection, context, () => localAllowRuleUpdate(context.toolName));
    }
}
