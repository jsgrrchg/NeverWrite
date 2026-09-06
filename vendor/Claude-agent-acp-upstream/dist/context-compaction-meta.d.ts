export declare const CONTEXT_COMPACTION_META_KEY = "contextCompaction";
export declare const CONTEXT_COMPACTION_META_VERSION = 1;
export type ContextCompactionTrigger = "manual" | "automatic";
export interface ContextCompactionMetadata {
    version: typeof CONTEXT_COMPACTION_META_VERSION;
    trigger?: ContextCompactionTrigger;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    error?: string;
}
/**
 * Provider-neutral metadata for a synthetic ACP context-compaction tool call.
 * The standard toolCallId and status fields own lifecycle identity and phase;
 * this extension carries only compaction-specific facts.
 */
export declare function createContextCompactionMeta(metadata?: Omit<ContextCompactionMetadata, "version">): Record<typeof CONTEXT_COMPACTION_META_KEY, ContextCompactionMetadata>;
//# sourceMappingURL=context-compaction-meta.d.ts.map