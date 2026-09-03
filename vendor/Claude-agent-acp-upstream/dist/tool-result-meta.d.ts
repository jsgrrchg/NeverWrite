export type ToolResultMeta = {
    nonExecutionKind: string;
    userFeedback?: string;
};
/** Validate the SDK's currently untyped tool_result_meta sidecar. Unknown
 * non-execution kinds are preserved so newer CLIs remain forward-compatible. */
export declare function parseToolResultMeta(raw: unknown): Map<string, ToolResultMeta> | undefined;
//# sourceMappingURL=tool-result-meta.d.ts.map