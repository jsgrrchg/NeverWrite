export const PERMISSION_OPTION_ID = {
    allowOnce: "allow-once",
    allowWithUpdates: "allow-with-updates",
    allowSkillExact: "allow-skill-exact",
    allowSkillPrefix: "allow-skill-prefix",
    exitPlanBypass: "exit-plan-bypass",
    exitPlanAuto: "exit-plan-auto",
    exitPlanAcceptEdits: "exit-plan-accept-edits",
    exitPlanDefault: "exit-plan-default",
    exitPlanClearAuto: "exit-plan-clear-auto",
    exitPlanClearBypass: "exit-plan-clear-bypass",
    exitPlanClearAcceptEdits: "exit-plan-clear-accept-edits",
    reject: "reject",
};
export function allowOnce(name = "Yes") {
    return { optionId: PERMISSION_OPTION_ID.allowOnce, name, kind: "allow_once" };
}
export function allowWithUpdates(name) {
    return { optionId: PERMISSION_OPTION_ID.allowWithUpdates, name, kind: "allow_always" };
}
export function reject(name = "No") {
    return { optionId: PERMISSION_OPTION_ID.reject, name, kind: "reject_once" };
}
export function withOptionalUpdate(changeSet, updateName, allowName = "Yes", rejectName = "No") {
    const options = [allowOnce(allowName)];
    if (changeSet && updateName)
        options.push(allowWithUpdates(updateName));
    options.push(reject(rejectName));
    return options;
}
export function plainString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function exactLocalAllowRule(changeSet, toolName, ruleContent) {
    if (!changeSet || changeSet.updates.length !== 1)
        return false;
    const update = changeSet.updates[0];
    if (update?.type !== "addRules" ||
        update.behavior !== "allow" ||
        update.destination !== "localSettings" ||
        update.rules.length !== 1) {
        return false;
    }
    const rule = update.rules[0];
    return (rule?.toolName === toolName &&
        (ruleContent === undefined
            ? rule.ruleContent === undefined
            : plainString(rule.ruleContent) === ruleContent));
}
/**
 * An MCP "don't ask again" option is only truthful when every provider update
 * adds an unrestricted allow rule for the tool currently being prompted.
 */
export function isMcpAllowChangeSet(changeSet, toolName) {
    return (!!changeSet &&
        changeSet.updates.length > 0 &&
        changeSet.updates.every((update) => update.type === "addRules" &&
            update.behavior === "allow" &&
            update.rules.length > 0 &&
            update.rules.every((rule) => rule.toolName === toolName && rule.ruleContent === undefined)));
}
export function withGeneratedUpdate(name, rejectName = "No") {
    return [allowOnce(), allowWithUpdates(name), reject(rejectName)];
}
