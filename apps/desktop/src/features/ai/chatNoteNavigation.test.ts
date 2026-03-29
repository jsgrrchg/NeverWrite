import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore, isMapTab } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { openChatMapByReference } from "./chatNoteNavigation";

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
            tags: [],
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
            .tabs.find((tab) => tab.id === useEditorStore.getState().activeTabId);
        expect(activeTab && isMapTab(activeTab)).toBe(true);
        expect(activeTab && isMapTab(activeTab) && activeTab.relativePath).toBe(
            "Excalidraw/Architecture.excalidraw",
        );
    });
});
