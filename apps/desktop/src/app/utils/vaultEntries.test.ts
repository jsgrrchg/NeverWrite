import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@neverwrite/runtime";
import { useEditorStore } from "../store/editorStore";
import { useVaultStore } from "../store/vaultStore";
import {
    getVaultEntryDisplayName,
    isAllowedByExtensionFilter,
    isCuratedVaultEntry,
    isTextLikeVaultEntry,
    openVaultFileEntry,
    shouldIncludeFileSummaryInFileScope,
    shouldIncludeMarkdownNotesInFileScope,
    shouldIncludeVaultEntryInFileScope,
    shouldShowVaultEntryInFileTree,
} from "./vaultEntries";
import { setEditorTabs } from "../../test/test-utils";

function buildEntry(
    path: string,
    options: {
        kind?: "note" | "pdf" | "file" | "folder";
        mimeType?: string | null;
        isImageLike?: boolean | null;
    } = {},
) {
    const fileName = path.split("/").pop() ?? path;
    const extension = fileName.includes(".")
        ? (fileName.split(".").pop() ?? "")
        : "";

    return {
        id: path,
        path: `/vault/${path}`,
        relative_path: path,
        title: fileName.replace(/\.[^/.]+$/, ""),
        file_name: fileName,
        extension,
        kind: options.kind ?? "file",
        modified_at: 1,
        created_at: 1,
        size: 1,
        mime_type: options.mimeType ?? null,
        is_image_like: options.isImageLike ?? null,
    };
}

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
        expect(
            isTextLikeVaultEntry({
                extension: "mmd",
                file_name: "flow.mmd",
                mime_type: null,
            }),
        ).toBe(true);
        expect(
            isTextLikeVaultEntry({
                extension: "mermaid",
                file_name: "flow.mermaid",
                mime_type: null,
            }),
        ).toBe(true);
    });

    it("identifies the curated default vault entry set", () => {
        expect(
            isCuratedVaultEntry(buildEntry("docs/reference.pdf", { kind: "pdf" })),
        ).toBe(true);
        expect(
            isCuratedVaultEntry(buildEntry("docs/page.html", { mimeType: "text/html" })),
        ).toBe(true);
        expect(
            isCuratedVaultEntry(buildEntry("docs/page.htm", { mimeType: "text/html" })),
        ).toBe(true);
        expect(
            isCuratedVaultEntry(buildEntry("docs/data.csv", { mimeType: "text/csv" })),
        ).toBe(true);
        expect(
            isCuratedVaultEntry(
                buildEntry("docs/diagram.excalidraw", {
                    mimeType: "application/json",
                }),
            ),
        ).toBe(true);
        expect(isCuratedVaultEntry(buildEntry("docs/flow.mmd"))).toBe(true);
        expect(isCuratedVaultEntry(buildEntry("docs/flow.mermaid"))).toBe(
            true,
        );
        expect(
            isCuratedVaultEntry(buildEntry("docs/readme.txt", { mimeType: "text/plain" })),
        ).toBe(true);
        expect(
            isCuratedVaultEntry(
                buildEntry("docs/photo.png", {
                    mimeType: "image/png",
                    isImageLike: true,
                }),
            ),
        ).toBe(true);

        expect(
            isCuratedVaultEntry(
                buildEntry("docs/config.toml", { mimeType: "application/toml" }),
            ),
        ).toBe(false);
        expect(
            isCuratedVaultEntry(
                buildEntry("docs/package.json", { mimeType: "application/json" }),
            ),
        ).toBe(false);
        expect(
            isCuratedVaultEntry(
                buildEntry("src/runtime.ts", { mimeType: "text/typescript" }),
            ),
        ).toBe(false);
    });

    it("applies file scope rules to vault entries and file tree folders", () => {
        const folder = buildEntry("docs", { kind: "folder" });
        const csv = buildEntry("docs/data.csv", { mimeType: "text/csv" });
        const toml = buildEntry("docs/config.toml", {
            mimeType: "application/toml",
        });
        const mermaid = buildEntry("docs/flow.mmd");

        expect(
            shouldShowVaultEntryInFileTree(folder, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldIncludeVaultEntryInFileScope(folder, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(false);
        expect(
            shouldShowVaultEntryInFileTree(csv, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldShowVaultEntryInFileTree(mermaid, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldShowVaultEntryInFileTree(toml, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(false);
        expect(
            shouldShowVaultEntryInFileTree(toml, {
                contentMode: "all_files",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldShowVaultEntryInFileTree(toml, {
                contentMode: "all_files",
                extensionFilter: ["csv"],
            }),
        ).toBe(false);
        expect(isAllowedByExtensionFilter(csv, ["csv"])).toBe(true);
    });

    it("decides whether markdown notes are in the current file scope", () => {
        expect(
            shouldIncludeMarkdownNotesInFileScope({
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldIncludeMarkdownNotesInFileScope({
                contentMode: "all_files",
                extensionFilter: ["csv"],
            }),
        ).toBe(false);
        expect(
            shouldIncludeMarkdownNotesInFileScope({
                contentMode: "all_files",
                extensionFilter: ["md"],
            }),
        ).toBe(true);
    });

    it("applies file scope rules to text-like file summaries", () => {
        const csv = {
            fileName: "data.csv",
            relativePath: "docs/data.csv",
            mimeType: "text/csv",
        };
        const toml = {
            fileName: "config.toml",
            relativePath: "docs/config.toml",
            mimeType: "application/toml",
        };
        const image = {
            fileName: "photo.png",
            relativePath: "docs/photo.png",
            mimeType: "image/png",
        };
        const mermaid = {
            fileName: "flow.mermaid",
            relativePath: "docs/flow.mermaid",
            mimeType: null,
        };

        expect(
            shouldIncludeFileSummaryInFileScope(csv, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldIncludeFileSummaryInFileScope(mermaid, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldIncludeFileSummaryInFileScope(toml, {
                contentMode: "notes_only",
                extensionFilter: [],
            }),
        ).toBe(false);
        expect(
            shouldIncludeFileSummaryInFileScope(toml, {
                contentMode: "all_files",
                extensionFilter: [],
            }),
        ).toBe(true);
        expect(
            shouldIncludeFileSummaryInFileScope(toml, {
                contentMode: "all_files",
                extensionFilter: ["csv"],
            }),
        ).toBe(false);
        expect(
            shouldIncludeFileSummaryInFileScope(image, {
                contentMode: "all_files",
                extensionFilter: [],
            }),
        ).toBe(false);
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
