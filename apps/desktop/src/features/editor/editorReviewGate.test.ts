import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    disposeSettingsStoreRuntime,
    initializeSettingsStore,
    useSettingsStore,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    isAiReviewEnabledForCurrentVault,
    isInlineReviewEnabledForCurrentVault,
    shouldEnableInlineReviewMergeView,
    shouldSyncTrackedEditorReviewTarget,
} from "./editorReviewGate";

describe("editorReviewGate", () => {
    beforeEach(() => {
        disposeSettingsStoreRuntime();
        initializeSettingsStore();
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: null,
            isLoading: false,
            vaultOpenState: {
                ...state.vaultOpenState,
                path: null,
                stage: "idle",
            },
        }));
    });

    afterEach(() => {
        disposeSettingsStoreRuntime();
    });

    it("defaults inline review to enabled for the current vault", () => {
        expect(isAiReviewEnabledForCurrentVault()).toBe(true);
        expect(isInlineReviewEnabledForCurrentVault()).toBe(true);
        expect(shouldEnableInlineReviewMergeView("source")).toBe(true);
        expect(shouldEnableInlineReviewMergeView("preview")).toBe(false);
        expect(shouldSyncTrackedEditorReviewTarget()).toBe(true);
    });

    it("reflects the per-vault inline review setting", () => {
        useVaultStore.setState({ vaultPath: "/vaults/review-off" });
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        expect(isInlineReviewEnabledForCurrentVault()).toBe(false);
        expect(shouldEnableInlineReviewMergeView("source")).toBe(false);
        expect(shouldEnableInlineReviewMergeView("preview")).toBe(false);
        expect(shouldSyncTrackedEditorReviewTarget()).toBe(false);
    });

    it("disables all editor review access when AI change review is disabled", () => {
        useVaultStore.setState({ vaultPath: "/vaults/ai-review-off" });
        useSettingsStore.getState().setSetting("aiReviewEnabled", false);

        expect(isAiReviewEnabledForCurrentVault()).toBe(false);
        expect(isInlineReviewEnabledForCurrentVault()).toBe(false);
        expect(shouldEnableInlineReviewMergeView("source")).toBe(false);
        expect(shouldSyncTrackedEditorReviewTarget()).toBe(false);

        useSettingsStore.getState().setSetting("aiReviewEnabled", true);

        expect(isInlineReviewEnabledForCurrentVault()).toBe(true);
    });

    it("tracks vault changes through the shared settings store", () => {
        useVaultStore.setState({ vaultPath: "/vaults/one" });
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        useVaultStore.setState({ vaultPath: "/vaults/two" });
        expect(isInlineReviewEnabledForCurrentVault()).toBe(true);

        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);
        expect(isInlineReviewEnabledForCurrentVault()).toBe(false);

        useVaultStore.setState({ vaultPath: "/vaults/one" });
        expect(isInlineReviewEnabledForCurrentVault()).toBe(false);
    });
});
