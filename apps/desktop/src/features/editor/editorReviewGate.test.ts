import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    disposeSettingsStoreRuntime,
    initializeSettingsStore,
    useSettingsStore,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
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
