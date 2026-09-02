import { applyClaudePermissionSelection, parseClaudePermissionSelection } from "./effects.js";
/** Decode, validate, and interpret an ACP response exactly once. */
export function decodeClaudePermissionResponse(response, toolName, input, toolUseID, offeredOptions, durableChangeSet) {
    const selection = parseClaudePermissionSelection(response, toolName);
    const offeredOption = offeredOptions.find((option) => option.optionId === selection.optionId);
    if (!offeredOption) {
        throw new Error(`Permission option was not offered: ${selection.optionId}`);
    }
    const permissionResult = applyClaudePermissionSelection(selection, {
        toolName,
        input,
        toolUseID,
        durableChangeSet,
    });
    return {
        permissionResult,
        ...(selection.contextResetMode ? { contextResetMode: selection.contextResetMode } : {}),
    };
}
