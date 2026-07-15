import { normalizeVaultRoot } from "./vaultPaths";

const AI_AUTO_CONTEXT_GLOBAL_SCOPE = "__global__";
const AI_STORAGE_SCOPE_KEY_PREFIX = "neverwrite.ai.storage-scope:";
const AI_HISTORY_RETENTION_KEY_PREFIX = "neverwrite.ai.history-retention:";

export function getVaultPreferenceScope(vaultPath: string | null) {
    return normalizeVaultRoot(vaultPath) ?? AI_AUTO_CONTEXT_GLOBAL_SCOPE;
}

export function getAiStorageScopeKey(vaultPath: string | null) {
    return `${AI_STORAGE_SCOPE_KEY_PREFIX}${getVaultPreferenceScope(vaultPath)}`;
}

export function getHistoryRetentionStorageKey(vaultPath: string | null) {
    return `${AI_HISTORY_RETENTION_KEY_PREFIX}${getVaultPreferenceScope(vaultPath)}`;
}

export function getAiVaultPreferenceStorageKeys(vaultPath: string | null) {
    return [
        getAiStorageScopeKey(vaultPath),
        getHistoryRetentionStorageKey(vaultPath),
    ];
}
