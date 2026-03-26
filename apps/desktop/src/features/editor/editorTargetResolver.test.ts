/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    findOpenFileTarget,
    findOpenNoteTarget,
    resolveEditorTargetForTrackedPath,
    resolveMarkdownNoteIdForPath,
} from "./editorTargetResolver";

describe("editorTargetResolver", () => {
    beforeEach(() => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
            currentSelection: null,
        });
    });

    it("resolves an open markdown note target from its absolute path", () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "hello",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });

        expect(resolveMarkdownNoteIdForPath("/vault/notes/current.md")).toBe(
            "notes/current",
        );
        expect(findOpenNoteTarget("/vault/notes/current.md")).toMatchObject({
            kind: "note",
            noteId: "notes/current",
            absolutePath: "/vault/notes/current.md",
            openTab: {
                id: "tab-1",
            },
        });
        expect(
            resolveEditorTargetForTrackedPath("/vault/notes/current.md"),
        ).toMatchObject({
            kind: "note",
            noteId: "notes/current",
        });
    });

    it("resolves an open text file target from its absolute path", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "file",
                    relativePath: "src/watcher.rs",
                    path: "/vault/src/watcher.rs",
                    title: "watcher.rs",
                    content: "fn main() {}",
                    mimeType: "text/rust",
                    viewer: "text",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });

        expect(findOpenFileTarget("/vault/src/watcher.rs")).toMatchObject({
            kind: "file",
            relativePath: "src/watcher.rs",
            absolutePath: "/vault/src/watcher.rs",
            openTab: {
                id: "tab-1",
            },
        });
        expect(
            resolveEditorTargetForTrackedPath("/vault/src/watcher.rs"),
        ).toMatchObject({
            kind: "file",
            relativePath: "src/watcher.rs",
        });
    });

    it("resolves an open text file target by absolute path even without a vault root", () => {
        useVaultStore.setState({
            vaultPath: null,
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "file",
                    relativePath: "src/watcher.rs",
                    path: "/vault/src/watcher.rs",
                    title: "watcher.rs",
                    content: "fn main() {}",
                    mimeType: "text/rust",
                    viewer: "text",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });

        expect(findOpenFileTarget("/vault/src/watcher.rs")).toMatchObject({
            kind: "file",
            relativePath: "src/watcher.rs",
            absolutePath: "/vault/src/watcher.rs",
            openTab: {
                id: "tab-1",
            },
        });
    });

    it("prefers an open note tab for non-markdown tracked paths", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "/vault/src/watcher.rs",
                    title: "watcher.rs",
                    content: "fn main() {}",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });

        expect(findOpenNoteTarget("/vault/src/watcher.rs")).toMatchObject({
            kind: "note",
            noteId: "/vault/src/watcher.rs",
            absolutePath: "/vault/src/watcher.rs",
            openTab: {
                id: "tab-1",
            },
        });
        expect(
            resolveEditorTargetForTrackedPath("/vault/src/watcher.rs"),
        ).toMatchObject({
            kind: "note",
            noteId: "/vault/src/watcher.rs",
        });
    });

    it("resolves a closed markdown note target from the vault index", () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "daily/2026-03-25",
                    path: "/vault/daily/2026-03-25.md",
                    title: "2026-03-25",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        expect(
            resolveEditorTargetForTrackedPath("/vault/daily/2026-03-25.md"),
        ).toMatchObject({
            kind: "note",
            noteId: "daily/2026-03-25",
            absolutePath: "/vault/daily/2026-03-25.md",
            openTab: null,
        });
    });
});
