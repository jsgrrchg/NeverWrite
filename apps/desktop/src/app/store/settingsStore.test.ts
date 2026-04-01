import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    disposeSettingsStoreRuntime,
    initializeSettingsStore,
    useSettingsStore,
} from "./settingsStore";
import { useVaultStore } from "./vaultStore";

describe("settingsStore developer mode", () => {
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

    it("defaults developerModeEnabled to false", () => {
        expect(useSettingsStore.getState().developerModeEnabled).toBe(false);
        expect(useSettingsStore.getState().developerTerminalEnabled).toBe(true);
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(true);
    });

    it("persists developerModeEnabled per vault", () => {
        useVaultStore.setState({ vaultPath: "/vaults/devtools" });

        useSettingsStore.getState().setSetting("developerModeEnabled", true);
        useSettingsStore
            .getState()
            .setSetting("developerTerminalEnabled", false);
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        expect(useSettingsStore.getState().developerModeEnabled).toBe(true);
        expect(useSettingsStore.getState().developerTerminalEnabled).toBe(
            false,
        );
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(false);
        expect(
            JSON.parse(
                localStorage.getItem("vaultai:settings:/vaults/devtools") ?? "",
            ),
        ).toMatchObject({
            state: {
                developerModeEnabled: true,
                developerTerminalEnabled: false,
                inlineReviewEnabled: false,
            },
        });
    });

    it("persists custom spellcheck language tags as plain strings", () => {
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "fr_fr");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "en_us");

        expect(useSettingsStore.getState().spellcheckPrimaryLanguage).toBe(
            "fr-FR",
        );
        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            "en-US",
        );
        expect(
            JSON.parse(localStorage.getItem("vaultai:settings") ?? ""),
        ).toMatchObject({
            state: {
                spellcheckPrimaryLanguage: "fr-FR",
                spellcheckSecondaryLanguage: "en-US",
            },
        });
    });

    it("keeps spellcheck languages per vault across vault changes", () => {
        useVaultStore.setState({ vaultPath: "/vaults/one" });
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "es-CL");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "en-US");
        useSettingsStore.getState().setSetting("developerModeEnabled", true);
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        useVaultStore.setState({ vaultPath: "/vaults/two" });

        expect(useSettingsStore.getState().spellcheckPrimaryLanguage).toBe(
            "system",
        );
        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            null,
        );
        expect(useSettingsStore.getState().developerModeEnabled).toBe(false);
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(true);

        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "fr-FR");

        useVaultStore.setState({ vaultPath: "/vaults/one" });

        expect(useSettingsStore.getState().spellcheckPrimaryLanguage).toBe(
            "es-CL",
        );
        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            "en-US",
        );
        expect(useSettingsStore.getState().developerModeEnabled).toBe(true);
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(false);
    });

    it("migrates legacy global spellcheck settings into existing vault settings", () => {
        localStorage.setItem(
            "vaultai:settings",
            JSON.stringify({
                state: {
                    spellcheckPrimaryLanguage: "es-CL",
                    spellcheckSecondaryLanguage: "en-US",
                },
            }),
        );
        localStorage.setItem(
            "vaultai:settings:/vaults/migrated",
            JSON.stringify({
                state: {
                    developerModeEnabled: true,
                },
            }),
        );

        useVaultStore.setState({ vaultPath: "/vaults/migrated" });

        expect(useSettingsStore.getState().spellcheckPrimaryLanguage).toBe(
            "es-CL",
        );
        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            "en-US",
        );
        expect(useSettingsStore.getState().developerModeEnabled).toBe(true);
        expect(
            JSON.parse(
                localStorage.getItem("vaultai:settings:/vaults/migrated") ?? "",
            ),
        ).toMatchObject({
            state: {
                developerModeEnabled: true,
                spellcheckPrimaryLanguage: "es-CL",
                spellcheckSecondaryLanguage: "en-US",
            },
        });
    });

    it("normalizes invalid secondary spellcheck values to null", () => {
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "en-US");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "system");

        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            null,
        );

        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "en_us");

        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            null,
        );
    });
});
