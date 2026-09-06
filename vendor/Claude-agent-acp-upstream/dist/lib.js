// Export the main agent class and utilities for library usage
export { ClaudeAcpAgent, isLocalCommandMetadata, stripLocalCommandMetadata, runAcp, toAcpNotifications, streamEventToAcpNotifications, } from "./acp-agent.js";
export { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";
export { toolInfoFromToolUse, toDisplayPath, planEntries, toolUpdateFromToolResult, } from "./tools.js";
export { SettingsManager } from "./settings.js";
// The `authStatus` extension's wire surface: the notification's method name and
// the payload types needed to read the traffic. The mappers stay internal.
export { AUTH_STATUS_UPDATE_METHOD, } from "./auth-status.js";
