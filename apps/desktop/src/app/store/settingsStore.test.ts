import { describe, expect, it } from "vitest";
import { useSettingsStore } from "./settingsStore";
import { useVaultStore } from "./vaultStore";

describe("settingsStore developer mode", () => {
    it("defaults developerModeEnabled to false", () => {
        expect(useSettingsStore.getState().developerModeEnabled).toBe(false);
        expect(useSettingsStore.getState().developerTerminalEnabled).toBe(true);
    });

    it("persists developerModeEnabled per vault", () => {
        useVaultStore.setState({ vaultPath: "/vaults/devtools" });

        useSettingsStore.getState().setSetting("developerModeEnabled", true);
        useSettingsStore
            .getState()
            .setSetting("developerTerminalEnabled", false);

        expect(useSettingsStore.getState().developerModeEnabled).toBe(true);
        expect(useSettingsStore.getState().developerTerminalEnabled).toBe(
            false,
        );
        expect(
            JSON.parse(
                localStorage.getItem("vaultai:settings:/vaults/devtools") ?? "",
            ),
        ).toMatchObject({
            state: {
                developerModeEnabled: true,
                developerTerminalEnabled: false,
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

    it("keeps spellcheck languages global across vault changes", () => {
        useVaultStore.setState({ vaultPath: "/vaults/one" });
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "es-CL");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "en-US");
        useSettingsStore.getState().setSetting("developerModeEnabled", true);

        useVaultStore.setState({ vaultPath: "/vaults/two" });

        expect(useSettingsStore.getState().spellcheckPrimaryLanguage).toBe(
            "es-CL",
        );
        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            "en-US",
        );
        expect(useSettingsStore.getState().developerModeEnabled).toBe(false);
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
