import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    disposeSettingsStoreRuntime,
    initializeSettingsStore,
    useSettingsStore,
} from "./settingsStore";
import { useVaultStore } from "./vaultStore";

describe("settingsStore", () => {
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

    it("defaults app settings", () => {
        expect(useSettingsStore.getState().terminalFontFamily).toBe("");
        expect(useSettingsStore.getState().terminalFontSize).toBe(13);
        expect(useSettingsStore.getState().claudeCodeOptimized).toBe(false);
        expect(useSettingsStore.getState().claudeCodeSkipPermissions).toBe(
            false,
        );
        expect(useSettingsStore.getState().claudeCodeModel).toBe("");
        expect(useSettingsStore.getState().claudeCodeContinueSession).toBe(
            false,
        );
        expect(useSettingsStore.getState().claudeCodeMaxTurns).toBe(0);
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(true);
        expect(useSettingsStore.getState().pdfFilter).toBe("none");
        expect(useSettingsStore.getState().editorSpellcheck).toBe(false);
        expect(useSettingsStore.getState().fileTreeScale).toBe(114);
        expect(useSettingsStore.getState().agentsSidebarScale).toBe(100);
        expect(useSettingsStore.getState().fileTreeStickyFolders).toBe(true);
        expect(useSettingsStore.getState().editorAutosaveDelayMs).toBe(300);
        expect(useSettingsStore.getState().fileTreeExtensionFilter).toEqual([]);
    });

    it("persists settings per vault", () => {
        useVaultStore.setState({ vaultPath: "/vaults/devtools" });

        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);
        useSettingsStore.getState().setSetting("pdfFilter", "sepia");
        useSettingsStore.getState().setSetting("fileTreeStickyFolders", false);
        useSettingsStore.getState().setSetting("agentsSidebarScale", 125);
        useSettingsStore.getState().setSetting("editorAutosaveDelayMs", 750);

        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(false);
        expect(useSettingsStore.getState().pdfFilter).toBe("sepia");
        expect(useSettingsStore.getState().fileTreeStickyFolders).toBe(false);
        expect(useSettingsStore.getState().agentsSidebarScale).toBe(125);
        expect(useSettingsStore.getState().editorAutosaveDelayMs).toBe(750);
        expect(
            JSON.parse(
                localStorage.getItem("neverwrite:settings:/vaults/devtools") ?? "",
            ),
        ).toMatchObject({
            state: {
                inlineReviewEnabled: false,
                pdfFilter: "sepia",
                fileTreeStickyFolders: false,
                agentsSidebarScale: 125,
                editorAutosaveDelayMs: 750,
            },
        });
    });

    it("persists terminal settings per vault", () => {
        useVaultStore.setState({ vaultPath: "/vaults/terminal" });

        useSettingsStore
            .getState()
            .setSetting("terminalFontFamily", "FiraCode Nerd Font");
        useSettingsStore.getState().setSetting("terminalFontSize", 16);
        useSettingsStore.getState().setSetting("claudeCodeOptimized", true);
        useSettingsStore
            .getState()
            .setSetting("claudeCodeSkipPermissions", true);
        useSettingsStore
            .getState()
            .setSetting("claudeCodeModel", "claude-sonnet-4-6");
        useSettingsStore
            .getState()
            .setSetting("claudeCodeContinueSession", true);
        useSettingsStore.getState().setSetting("claudeCodeMaxTurns", 12);

        expect(
            JSON.parse(
                localStorage.getItem("neverwrite:settings:/vaults/terminal") ??
                    "",
            ),
        ).toMatchObject({
            state: {
                terminalFontFamily: "FiraCode Nerd Font",
                terminalFontSize: 16,
                claudeCodeOptimized: true,
                claudeCodeSkipPermissions: true,
                claudeCodeModel: "claude-sonnet-4-6",
                claudeCodeContinueSession: true,
                claudeCodeMaxTurns: 12,
            },
        });
    });

    it("normalizes persisted terminal numeric settings", () => {
        localStorage.setItem(
            "neverwrite:settings",
            JSON.stringify({
                state: {
                    terminalFontSize: 99,
                    claudeCodeMaxTurns: -3,
                },
            }),
        );

        disposeSettingsStoreRuntime();
        initializeSettingsStore();

        expect(useSettingsStore.getState().terminalFontSize).toBe(24);
        expect(useSettingsStore.getState().claudeCodeMaxTurns).toBe(0);
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
            JSON.parse(localStorage.getItem("neverwrite:settings") ?? ""),
        ).toMatchObject({
            state: {
                spellcheckPrimaryLanguage: "fr-FR",
                spellcheckSecondaryLanguage: "en-US",
            },
        });
    });

    it("normalizes invalid persisted PDF filters to normal", () => {
        localStorage.setItem(
            "neverwrite:settings",
            JSON.stringify({
                state: {
                    pdfFilter: "solarized",
                },
            }),
        );

        disposeSettingsStoreRuntime();
        initializeSettingsStore();

        expect(useSettingsStore.getState().pdfFilter).toBe("none");
    });

    it("normalizes persisted file tree extension filters", () => {
        localStorage.setItem(
            "neverwrite:settings",
            JSON.stringify({
                state: {
                    fileTreeExtensionFilter: [
                        ".MD",
                        " csv ",
                        "md",
                        "",
                        42,
                        null,
                        ".PDF",
                        ".csv",
                    ],
                },
            }),
        );

        disposeSettingsStoreRuntime();
        initializeSettingsStore();

        expect(useSettingsStore.getState().fileTreeExtensionFilter).toEqual([
            "md",
            "csv",
            "pdf",
        ]);
    });

    it("keeps spellcheck languages per vault across vault changes", () => {
        useVaultStore.setState({ vaultPath: "/vaults/one" });
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "es-CL");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "en-US");
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        useVaultStore.setState({ vaultPath: "/vaults/two" });

        expect(useSettingsStore.getState().spellcheckPrimaryLanguage).toBe(
            "system",
        );
        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            null,
        );
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
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(false);
    });

    it("does not enable spellcheck for a new vault migrated from legacy global settings", () => {
        localStorage.setItem(
            "neverwrite:settings",
            JSON.stringify({
                state: {
                    editorSpellcheck: true,
                    developerModeEnabled: true,
                },
            }),
        );

        useVaultStore.setState({ vaultPath: "/vaults/new" });

        expect(useSettingsStore.getState().editorSpellcheck).toBe(false);
        const stored = JSON.parse(
            localStorage.getItem("neverwrite:settings:/vaults/new") ?? "",
        ) as { state: Record<string, unknown> };
        expect(stored.state.editorSpellcheck).toBe(false);
        expect(stored.state).not.toHaveProperty("developerModeEnabled");
    });

    it("migrates legacy global spellcheck settings into existing vault settings", () => {
        localStorage.setItem(
            "neverwrite:settings",
            JSON.stringify({
                state: {
                    spellcheckPrimaryLanguage: "es-CL",
                    spellcheckSecondaryLanguage: "en-US",
                },
            }),
        );
        localStorage.setItem(
            "neverwrite:settings:/vaults/migrated",
            JSON.stringify({
                state: {
                    inlineReviewEnabled: false,
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
        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(false);
        expect(
            JSON.parse(
                localStorage.getItem("neverwrite:settings:/vaults/migrated") ?? "",
            ),
        ).toMatchObject({
            state: {
                inlineReviewEnabled: false,
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
