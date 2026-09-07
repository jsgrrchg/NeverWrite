export const CONTEXT_COMPACTION_META_KEY = "contextCompaction";
export const CONTEXT_COMPACTION_META_VERSION = 1;
/**
 * Provider-neutral metadata for a synthetic ACP context-compaction tool call.
 * The standard toolCallId and status fields own lifecycle identity and phase;
 * this extension carries only compaction-specific facts.
 */
export function createContextCompactionMeta(metadata = {}) {
    return {
        [CONTEXT_COMPACTION_META_KEY]: {
            version: CONTEXT_COMPACTION_META_VERSION,
            ...metadata,
        },
    };
}
