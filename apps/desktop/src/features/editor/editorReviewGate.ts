import {
    readSettingsForVault,
    useSettingsStore,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";

export type EditorReviewMode = "source" | "preview";

function getCurrentVaultReviewSettings() {
    const vaultState = useVaultStore.getState();
    const vaultPath =
        vaultState.vaultPath ??
        (vaultState.isLoading ? vaultState.vaultOpenState.path : null);
    const persistedSettings = readSettingsForVault(vaultPath);
    const activeSettings = useSettingsStore.getState();

    // Keep the fast path through the live store when runtime sync is active,
    // but fall back to the persisted per-vault snapshot for direct callers.
    if (
        activeSettings.aiReviewEnabled === persistedSettings.aiReviewEnabled &&
        activeSettings.inlineReviewEnabled ===
            persistedSettings.inlineReviewEnabled
    ) {
        return activeSettings;
    }

    return persistedSettings;
}

// AI change review is a per-vault setting. This helper must keep working both
// inside the live app runtime and in direct call sites used by tests/utilities.
export function isAiReviewEnabledForCurrentVault() {
    return getCurrentVaultReviewSettings().aiReviewEnabled;
}

export function isInlineReviewEnabledForCurrentVault() {
    const settings = getCurrentVaultReviewSettings();
    return settings.aiReviewEnabled && settings.inlineReviewEnabled;
}

export function shouldEnableInlineReviewMergeView(mode: EditorReviewMode) {
    return mode === "source" && isInlineReviewEnabledForCurrentVault();
}

export function shouldSyncTrackedEditorReviewTarget() {
    return isInlineReviewEnabledForCurrentVault();
}
