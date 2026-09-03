import { AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY, clientSupportsAirCapability, } from "./air-extension.js";
export { AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY } from "./air-extension.js";
export function clientSupportsSubagents(capabilities) {
    const subagents = capabilities?.subagents;
    if (typeof subagents === "object" && subagents !== null && !Array.isArray(subagents)) {
        return true;
    }
    return clientSupportsAirCapability(capabilities, AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY);
}
/** The only cast needed until the TypeScript SDK publishes PR #1992. */
export function asSdkSessionNotification(notification) {
    return notification;
}
