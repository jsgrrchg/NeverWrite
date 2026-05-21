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

function buildTextFileEntry(relativePath: string, mimeType = "text/plain") {
    const fileName = relativePath.split("/").pop() ?? relativePath;
    const dotIndex = fileName.lastIndexOf(".");

    return {
        id: relativePath,
        path: `/vault/${relativePath}`,
        relative_path: relativePath,
        title: dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName,
        file_name: fileName,
        extension: dotIndex > 0 ? fileName.slice(dotIndex + 1) : "",
        kind: "file" as const,
        modified_at: 0,
        created_at: 0,
        size: 12,
        mime_type: mimeType,
        is_text_like: true,
    };
}

describe("wikilinkSuggester", () => {
    beforeEach(() => {
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: `/vault-${crypto.randomUUID()}`,
            resolverRevision: state.resolverRevision + 1,
            entries: [],
        }));
        useSettingsStore.setState({
            fileTreeContentMode: "notes_only",
            fileTreeShowExtensions: false,
            fileTreeExtensionFilter: [],
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

    it("includes curated text files in wikilink suggestions when all-files mode is disabled", async () => {
        useVaultStore.setState((state) => ({
            ...state,
            entries: [
                {
                    id: "docs/data.csv",
                    path: "/vault/docs/data.csv",
                    relative_path: "docs/data.csv",
                    title: "data",
                    file_name: "data.csv",
                    extension: "csv",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 12,
                    mime_type: "text/csv",
                    is_text_like: true,
                },
                {
                    id: "docs/config.toml",
                    path: "/vault/docs/config.toml",
                    relative_path: "docs/config.toml",
                    title: "config",
                    file_name: "config.toml",
                    extension: "toml",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 12,
                    mime_type: "application/toml",
                    is_text_like: true,
                },
            ],
        }));
        mockInvoke().mockResolvedValue([]);

        const items = await getWikilinkSuggestions("notes/current", "data");

        expect(items).toEqual([
            expect.objectContaining({
                kind: "file",
                title: "data.csv",
                subtitle: "docs/data.csv",
                insertText: "/docs/data.csv",
            }),
        ]);
    });

    it("uses the extension allowlist as the wikilink suggestion scope", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeExtensionFilter: ["csv"],
        });
        useVaultStore.setState((state) => ({
            ...state,
            entries: [
                {
                    id: "docs/data.csv",
                    path: "/vault/docs/data.csv",
                    relative_path: "docs/data.csv",
                    title: "data",
                    file_name: "data.csv",
                    extension: "csv",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 12,
                    mime_type: "text/csv",
                    is_text_like: true,
                },
                {
                    id: "docs/config.toml",
                    path: "/vault/docs/config.toml",
                    relative_path: "docs/config.toml",
                    title: "config",
                    file_name: "config.toml",
                    extension: "toml",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 12,
                    mime_type: "application/toml",
                    is_text_like: true,
                },
            ],
        }));
        mockInvoke().mockResolvedValue([
            {
                id: "notes/data",
                title: "Data Note",
                subtitle: "notes/data",
                insert_text: "notes/data",
            },
        ]);

        const items = await getWikilinkSuggestions("notes/current", "data");

        expect(mockInvoke()).not.toHaveBeenCalled();
        expect(items).toEqual([
            expect.objectContaining({
                kind: "file",
                title: "data.csv",
            }),
        ]);
    });

    it("refreshes cached file suggestions when the vault structure changes", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeExtensionFilter: ["csv"],
        });
        useVaultStore.setState((state) => ({
            ...state,
            structureRevision: state.structureRevision + 1,
            entries: [buildTextFileEntry("docs/data.csv", "text/csv")],
        }));

        const first = await getWikilinkSuggestions("notes/current", "data");

        expect(first).toEqual([
            expect.objectContaining({
                kind: "file",
                title: "data.csv",
            }),
        ]);

        useVaultStore.setState((state) => ({
            ...state,
            structureRevision: state.structureRevision + 1,
            entries: [buildTextFileEntry("docs/report.csv", "text/csv")],
        }));

        const second = await getWikilinkSuggestions("notes/current", "data");

        expect(second).toEqual([]);
    });

    it("keeps backend note ordering before curated files in normal mode", async () => {
        useVaultStore.setState((state) => ({
            ...state,
            entries: [buildTextFileEntry("docs/data.csv", "text/csv")],
        }));
        mockInvoke().mockResolvedValue([
            {
                id: "notes/project",
                title: "Data Note",
                subtitle: "notes/project",
                insert_text: "notes/project",
            },
        ]);

        const items = await getWikilinkSuggestions("notes/current", "data");

        expect(items).toEqual([
            expect.objectContaining({
                kind: "note",
                title: "Data Note",
            }),
            expect.objectContaining({
                kind: "file",
                title: "data.csv",
            }),
        ]);
    });

    it("keeps file-oriented ranking for notes and files in all-files mode", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
        });
        useVaultStore.setState((state) => ({
            ...state,
            entries: [buildTextFileEntry("docs/data.csv", "text/csv")],
        }));
        mockInvoke().mockResolvedValue([
            {
                id: "notes/project",
                title: "Data Note",
                subtitle: "notes/project",
                insert_text: "notes/project",
            },
        ]);

        const items = await getWikilinkSuggestions("notes/current", "data");

        expect(items[0]).toEqual(
            expect.objectContaining({
                kind: "file",
                title: "data.csv",
            }),
        );
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
