import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../app/store/settingsStore";
import { mockInvoke } from "../../test/test-utils";
import { resolveFrontendSpellcheckLanguage } from "./api";
import { useSpellcheckStore } from "./store";

describe("spellcheck frontend store", () => {
    beforeEach(() => {
        useSettingsStore.getState().setSetting("editorSpellcheck", true);
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "system");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", null);
        useSpellcheckStore.setState({
            enabled: true,
            requestedPrimaryLanguage: "system",
            requestedSecondaryLanguage: null,
            resolvedPrimaryLanguage:
                resolveFrontendSpellcheckLanguage("system"),
            resolvedSecondaryLanguage: null,
            languages: [],
            runtimeDirectory: null,
            lastError: null,
            documentCache: new Map(),
            ignoredSessionWords: new Set(),
        });
    });

    it("resolves language variants once in the frontend layer", () => {
        Object.defineProperty(navigator, "language", {
            value: "es-CL",
            configurable: true,
        });

        expect(resolveFrontendSpellcheckLanguage("system")).toBe("es-ES");
        expect(resolveFrontendSpellcheckLanguage("en-GB")).toBe("en-GB");
        expect(resolveFrontendSpellcheckLanguage("es-MX")).toBe("es-MX");
        expect(resolveFrontendSpellcheckLanguage("en_us")).toBe("en-US");
        expect(resolveFrontendSpellcheckLanguage("pt-br")).toBe("pt-BR");
    });

    it("caches diagnostics by document, version and language", async () => {
        mockInvoke().mockResolvedValue({
            language: "en-US",
            secondary_language: null,
            diagnostics: [{ start_utf16: 0, end_utf16: 4, word: "wrld" }],
        });

        const first = await useSpellcheckStore.getState().checkDocument({
            documentId: "note:1",
            version: "v1",
            text: "wrld",
            language: "en-US",
        });
        const second = await useSpellcheckStore.getState().checkDocument({
            documentId: "note:1",
            version: "v1",
            text: "wrld",
            language: "en-US",
        });

        expect(first).toEqual(second);
        expect(mockInvoke()).toHaveBeenCalledTimes(1);
    });

    it("separates cache entries by primary and secondary language", async () => {
        mockInvoke()
            .mockResolvedValueOnce({
                language: "es-ES",
                secondary_language: "en-US",
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                language: "es-ES",
                secondary_language: null,
                diagnostics: [],
            });

        const first = await useSpellcheckStore.getState().checkDocument({
            documentId: "note:1",
            version: "v1",
            text: "hola world",
            language: "es-ES",
            secondaryLanguage: "en-US",
        });
        const second = await useSpellcheckStore.getState().checkDocument({
            documentId: "note:1",
            version: "v1",
            text: "hola world",
            language: "es-ES",
            secondaryLanguage: null,
        });

        expect(first.secondaryLanguage).toBe("en-US");
        expect(second.secondaryLanguage).toBe(null);
        expect(mockInvoke()).toHaveBeenCalledTimes(2);
        expect(mockInvoke()).toHaveBeenNthCalledWith(
            1,
            "spellcheck_check_text",
            {
                text: "hola world",
                language: "es-ES",
                secondaryLanguage: "en-US",
            },
        );
    });

    it("tracks ignored session words and clears document cache", async () => {
        mockInvoke().mockResolvedValue({
            language: "en-US",
            word: "wrld",
            updated: true,
            user_dictionary_path: "/tmp/spellcheck/user/en-US.txt",
        });

        useSpellcheckStore.setState({
            documentCache: new Map([
                [
                    "note:1",
                    {
                        documentId: "note:1",
                        version: "v1",
                        language: "en-US",
                        diagnostics: [
                            { start_utf16: 0, end_utf16: 4, word: "wrld" },
                        ],
                    },
                ],
            ]),
        });

        await useSpellcheckStore
            .getState()
            .ignoreWordForSession("wrld", "en-US");

        expect(useSpellcheckStore.getState().isWordIgnored("wrld")).toBe(true);
        expect(useSpellcheckStore.getState().documentCache.size).toBe(0);
    });

    it("installs catalog dictionaries and refreshes catalog plus languages", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_install_dictionary") {
                return {
                    language: "es-CL",
                    installed: true,
                    install_path: "/tmp/spellcheck/packs/es-CL",
                };
            }

            if (command === "spellcheck_list_languages") {
                return [];
            }

            if (command === "spellcheck_list_catalog") {
                return [
                    {
                        id: "es-CL",
                        label: "Spanish (Chile)",
                        version: "2026.03.15",
                        installed_version: "2026.03.15",
                        source: "LibreOffice / RLA-ES",
                        license: "GPL-3.0+ / LGPL-3.0+ / MPL-1.1+",
                        homepage: "https://github.com/LibreOffice/dictionaries",
                        bundled: false,
                        size_bytes: 868261,
                        installed: true,
                        update_available: false,
                        install_status: "installed",
                    },
                ];
            }

            return undefined;
        });

        const response = await useSpellcheckStore
            .getState()
            .installCatalogDictionary("es-CL");

        expect(response.installed).toBe(true);
        expect(useSpellcheckStore.getState().catalog[0]?.id).toBe("es-CL");
        expect(mockInvoke()).toHaveBeenCalledWith(
            "spellcheck_install_dictionary",
            { language: "es-CL" },
        );
    });
});
