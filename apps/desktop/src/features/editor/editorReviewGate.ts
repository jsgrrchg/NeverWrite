import {
    readSettingsForVault,
    useSettingsStore,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";

export type EditorReviewMode = "source" | "preview";

// Inline review is a per-vault setting. This helper must keep working both
// inside the live app runtime and in direct call sites used by tests/utilities.
export function isInlineReviewEnabledForCurrentVault() {
    const vaultState = useVaultStore.getState();
    const vaultPath =
        vaultState.vaultPath ??
        (vaultState.isLoading ? vaultState.vaultOpenState.path : null);
    const inlineReviewEnabled =
        readSettingsForVault(vaultPath).inlineReviewEnabled;

    // Keep the fast path through the live store when runtime sync is active,
    // but fall back to the persisted per-vault snapshot for direct callers.
    return useSettingsStore.getState().inlineReviewEnabled ===
        inlineReviewEnabled
        ? useSettingsStore.getState().inlineReviewEnabled
        : inlineReviewEnabled;
}

export function shouldEnableInlineReviewMergeView(mode: EditorReviewMode) {
    return mode === "source" && isInlineReviewEnabledForCurrentVault();
}

export function shouldSyncTrackedEditorReviewTarget() {
    return isInlineReviewEnabledForCurrentVault();
}
