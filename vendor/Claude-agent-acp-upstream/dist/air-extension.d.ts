export declare const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";
export declare const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";
export declare const AIR_SESSION_FAILURE_CAPABILITY = "sessionFailure";
/** The capability list this side advertises, as its own `_meta` object. */
export declare function airCapabilityMeta(...capabilities: string[]): Record<string, unknown>;
/**
 * Merges one AIR extension payload into an existing `_meta`.
 *
 * Every other namespace is preserved: an update can carry both agent-native
 * `claudeCode` metadata and an AIR payload, and two AIR payloads can share the
 * same `air` object. Pass `undefined` to build a fresh `_meta`.
 */
export declare function withAirMeta(meta: Record<string, unknown> | null | undefined, capability: string, payload: unknown): Record<string, unknown>;
/** The `air` object inside a `_meta`, or undefined when the peer sent no AIR extension. */
export declare function airExtensionMeta(meta: unknown): Record<string, unknown> | undefined;
/**
 * Whether the peer advertised `capability`.
 *
 * Takes `unknown` because every caller is reading wire data: an ACP
 * `ClientCapabilities`, or a bag whose `_meta` was never validated.
 */
export declare function clientSupportsAirCapability(capabilities: unknown, capability: string): boolean;
//# sourceMappingURL=air-extension.d.ts.map