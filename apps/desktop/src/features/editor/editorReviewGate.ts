import { useSettingsStore } from "../../app/store/settingsStore";

export type EditorReviewMode = "source" | "preview";

export function isInlineReviewEnabledForCurrentVault() {
    return useSettingsStore.getState().inlineReviewEnabled;
}

export function shouldEnableInlineReviewMergeView(mode: EditorReviewMode) {
    return mode === "source" && isInlineReviewEnabledForCurrentVault();
}

export function shouldSyncTrackedEditorReviewTarget() {
    return isInlineReviewEnabledForCurrentVault();
}
