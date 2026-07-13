import { invoke } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore, isMapTab } from "../../app/store/editorStore";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { setEditorTabs } from "../../test/test-utils";
import {
    findChatNoteByReference,
    openChatMapByReference,
    openChatNoteByReference,
} from "./chatNoteNavigation";

function makeNote(
    id: string,
    title = id.replace(/\.md$/i, "").split("/").at(-1) ?? id,
): NoteDto {
    return {
        id,
        path: `/vault/${id}`,
        title,
        modified_at: 0,
        created_at: 0,
    };
}

describe("openChatMapByReference", () => {
    beforeEach(() => {
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            recentlyClosedTabs: [],
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
        });
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
            vaultRevision: 0,
            structureRevision: 0,
        });
        vi.mocked(invoke).mockReset();
    });

    it("opens maps from legacy absolute path references inside the active vault", async () => {
        vi.mocked(invoke).mockImplementation(async (command) => {
            if (command === "list_maps") {
                return [
                    {
                        id: "Excalidraw/Architecture",
                        title: "Architecture",
                        relative_path: "Excalidraw/Architecture.excalidraw",
                    },
                ];
            }

            throw new Error(`Unexpected invoke call: ${command}`);
        });

        const opened = await openChatMapByReference(
            "/vault/Excalidraw/Architecture.excalidraw",
        );

        expect(opened).toBe(true);
        const activeTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => tab.id === useEditorStore.getState().activeTabId,
            );
        expect(activeTab && isMapTab(activeTab)).toBe(true);
        expect(activeTab && isMapTab(activeTab) && activeTab.relativePath).toBe(
            "Excalidraw/Architecture.excalidraw",
        );
    });
});

describe("findChatNoteByReference", () => {
    beforeEach(() => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
    });

    it("resolves an extensionless chat wikilink to a note inside folders", () => {
        const note = makeNote(
            "Análisis/Julio 2026/Análisis/Geopolitica/Ucrania-Rusia - Ficha de análisis julio 2026.md",
            "Ucrania-Rusia - Ficha de análisis julio 2026.md",
        );
        useVaultStore.setState({ notes: [note] });

        expect(
            findChatNoteByReference(
                "Ucrania-Rusia - Ficha de análisis julio 2026",
            ),
        ).toBe(note);
    });

    it("normalizes accent, space, and hyphen variants in generated links", () => {
        const note = makeNote(
            "research/Ucrania-Rusia - Ficha de análisis julio 2026.md",
        );
        useVaultStore.setState({ notes: [note] });

        expect(
            findChatNoteByReference(
                "ucrania-rusia-ficha-de-analisis-julio-2026",
            ),
        ).toBe(note);
    });

    it("does not open an arbitrary note when a basename is ambiguous", () => {
        useVaultStore.setState({
            notes: [
                makeNote("research/Brief.md"),
                makeNote("archive/Brief.md"),
            ],
        });

        expect(findChatNoteByReference("Brief")).toBeNull();
    });

    it("opens line references and queues the requested range for reveal", async () => {
        const note = makeNote("CHANGELOG.md");
        useVaultStore.setState({ notes: [note] });
        setEditorTabs(
            [
                {
                    id: "changelog-tab",
                    noteId: note.id,
                    title: note.title,
                    content: "line 1\nline 2",
                },
            ],
            "changelog-tab",
        );
        useEditorStore.setState({ pendingLineReveal: null });

        await expect(
            openChatNoteByReference("CHANGELOG.md#L66-L70"),
        ).resolves.toBe(true);
        expect(useEditorStore.getState().pendingLineReveal).toEqual({
            noteId: "CHANGELOG.md",
            line: 66,
            endLine: 70,
        });
    });
});
