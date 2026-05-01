/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { mockInvoke } from "../../../test/test-utils";
import {
    getWikilinkSuggestions,
    MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES,
} from "./wikilinkSuggester";

describe("wikilinkSuggester", () => {
    beforeEach(() => {
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: `/vault-${crypto.randomUUID()}`,
            resolverRevision: state.resolverRevision + 1,
        }));
        useSettingsStore.setState({
            fileTreeContentMode: "notes_only",
        });
    });

    it("reuses cached suggestions for the same query", async () => {
        mockInvoke().mockResolvedValue([
            {
                id: "note-1",
                title: "Target",
                subtitle: "/notes/target.md",
                insert_text: "Target",
            },
        ]);

        const first = await getWikilinkSuggestions("note/current", "tar");
        const second = await getWikilinkSuggestions("note/current", "tar");

        expect(first).toEqual(second);
        expect(mockInvoke()).toHaveBeenCalledTimes(1);
    });

    it("evicts the oldest cached query once the limit is exceeded", async () => {
        mockInvoke().mockImplementation(async (_command, payload) => {
            const request = payload as {
                query: string;
            };

            return [
                {
                    id: request.query,
                    title: request.query,
                    subtitle: `/notes/${request.query}.md`,
                    insert_text: request.query,
                },
            ];
        });

        for (
            let index = 0;
            index < MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES + 1;
            index += 1
        ) {
            await getWikilinkSuggestions("note/current", `query-${index}`, 8);
        }

        expect(mockInvoke()).toHaveBeenCalledTimes(
            MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES + 1,
        );

        await getWikilinkSuggestions("note/current", "query-0", 8);

        expect(mockInvoke()).toHaveBeenCalledTimes(
            MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES + 2,
        );
    });

    it("includes text files in wikilink suggestions when all-files mode is active", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
        });
        useVaultStore.setState((state) => ({
            ...state,
            entries: [
                {
                    id: "src/main.ts",
                    path: "/vault/src/main.ts",
                    relative_path: "src/main.ts",
                    title: "main",
                    file_name: "main.ts",
                    extension: "ts",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 12,
                    mime_type: "text/typescript",
                    is_text_like: true,
                },
            ],
        }));
        mockInvoke().mockResolvedValue([]);

        const items = await getWikilinkSuggestions("notes/current", "main");

        expect(items).toEqual([
            expect.objectContaining({
                kind: "file",
                title: "main.ts",
                subtitle: "src/main.ts",
                insertText: "/src/main.ts",
            }),
        ]);
    });

    it("shows Markdown note file names with extensions in all-files mode when extensions are enabled", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeShowExtensions: true,
        });
        mockInvoke().mockResolvedValue([
            {
                id: "Analysis/April 2026/Journal/1-05-27",
                title: "1-05-27",
                subtitle: "Analysis/April 2026/Journal/1-05-27",
                insert_text: "Analysis/April 2026/Journal/1-05-27",
            },
        ]);

        const items = await getWikilinkSuggestions("notes/current", "1-05");

        expect(items).toEqual([
            expect.objectContaining({
                kind: "note",
                title: "1-05-27.md",
                subtitle: "Analysis/April 2026/Journal/1-05-27",
                insertText: "Analysis/April 2026/Journal/1-05-27",
            }),
        ]);
    });

    it("keeps Markdown note file extensions hidden in all-files mode when extensions are disabled", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeShowExtensions: false,
        });
        mockInvoke().mockResolvedValue([
            {
                id: "notes/project-alpha",
                title: "Roadmap",
                subtitle: "notes/project-alpha",
                insert_text: "notes/project-alpha",
            },
        ]);

        const items = await getWikilinkSuggestions("notes/current", "alpha");

        expect(items).toEqual([
            expect.objectContaining({
                kind: "note",
                title: "project-alpha",
                insertText: "notes/project-alpha",
            }),
        ]);
    });
});
