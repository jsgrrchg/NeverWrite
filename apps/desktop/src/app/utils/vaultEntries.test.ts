import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../store/editorStore";
import { useVaultStore } from "../store/vaultStore";
import {
    getVaultEntryDisplayName,
    isTextLikeVaultEntry,
    openVaultFileEntry,
} from "./vaultEntries";
import { setEditorTabs } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
    openPath: vi.fn(),
}));

describe("vaultEntries", () => {
    beforeEach(() => {
        setEditorTabs([]);
        useVaultStore.setState({ vaultPath: "/vault" });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("treats common config files without standard extensions as text", () => {
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: "Dockerfile",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: "Makefile",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".env.local",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".prettierrc",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".gitignore",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "",
                file_name: ".eslintrc",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "mk",
                file_name: "rules.mk",
                mime_type: null,
            }),
        ).toBe(true);
    });

    it("falls back to the file name when a file title is empty", () => {
        expect(
            getVaultEntryDisplayName(
                {
                    kind: "file",
                    title: "",
                    file_name: ".gitignore",
                },
                false,
            ),
        ).toBe(".gitignore");
    });

    it("opens csv entries with the csv viewer", async () => {
        vi.mocked(invoke).mockResolvedValueOnce({
            path: "/vault/data/report.csv",
            relative_path: "data/report.csv",
            file_name: "report.csv",
            mime_type: "text/csv",
            content: "name,amount\nAlice,10",
        });

        await openVaultFileEntry({
            id: "csv-entry",
            kind: "file",
            path: "/vault/data/report.csv",
            relative_path: "data/report.csv",
            title: "report.csv",
            file_name: "report.csv",
            extension: "csv",
            modified_at: 0,
            created_at: 0,
            size: 22,
            mime_type: "text/csv",
        });

        const activeTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => tab.id === useEditorStore.getState().activeTabId,
            );

        expect(activeTab).toMatchObject({
            kind: "file",
            relativePath: "data/report.csv",
            viewer: "csv",
            content: "name,amount\nAlice,10",
        });
        expect(vi.mocked(invoke)).toHaveBeenCalledWith("read_vault_file", {
            relativePath: "data/report.csv",
            vaultPath: "/vault",
        });
    });

    it("inserts csv entries in a new tab with the csv viewer", async () => {
        setEditorTabs([
            {
                id: "existing-text-tab",
                kind: "file",
                relativePath: "notes/todo.txt",
                title: "todo.txt",
                path: "/vault/notes/todo.txt",
                mimeType: "text/plain",
                viewer: "text",
                content: "todo",
            },
        ]);

        vi.mocked(invoke).mockResolvedValueOnce({
            path: "/vault/data/report.csv",
            relative_path: "data/report.csv",
            file_name: "report.csv",
            mime_type: "text/csv",
            content: "name,amount\nAlice,10",
        });

        await openVaultFileEntry(
            {
                id: "csv-entry",
                kind: "file",
                path: "/vault/data/report.csv",
                relative_path: "data/report.csv",
                title: "report.csv",
                file_name: "report.csv",
                extension: "csv",
                modified_at: 0,
                created_at: 0,
                size: 22,
                mime_type: "text/csv",
            },
            { newTab: true },
        );

        const csvTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) =>
                    tab.kind === "file" &&
                    tab.relativePath === "data/report.csv",
            );

        expect(useEditorStore.getState().tabs).toHaveLength(2);
        expect(csvTab).toMatchObject({
            kind: "file",
            viewer: "csv",
            content: "name,amount\nAlice,10",
        });
        expect(useEditorStore.getState().activeTabId).toBe(csvTab?.id);
    });
});
