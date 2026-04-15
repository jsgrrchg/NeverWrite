import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { isMapTab, useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    createInitialLayout,
    splitPane,
} from "../../app/store/workspaceLayoutTree";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
} from "../../test/test-utils";
import { MapsPanel } from "./MapsPanel";

function buildMapListEntry(relativePath: string, title: string) {
    return {
        id: relativePath.replace(/\.excalidraw$/i, ""),
        title,
        relative_path: relativePath,
    };
}

function buildMovedMapEntry(relativePath: string, title: string) {
    const fileName = relativePath.split("/").pop() ?? relativePath;
    return {
        id: relativePath,
        path: `/vault/${relativePath}`,
        relative_path: relativePath,
        title,
        file_name: fileName,
        extension: "excalidraw",
        kind: "file" as const,
        modified_at: 1,
        created_at: 1,
        size: 128,
        mime_type: "application/json",
    };
}

function setFocusedPrimaryWorkspaceWithMapInSecondary() {
    const homeTab = {
        id: "note-1",
        kind: "note" as const,
        noteId: "notes/home",
        title: "Home",
        content: "# Home",
        history: [
            {
                kind: "note" as const,
                noteId: "notes/home",
                title: "Home",
                content: "# Home",
            },
        ],
        historyIndex: 0,
    };
    const mapTab = {
        id: "map-1",
        kind: "map" as const,
        title: "Map 2026-04-05",
        relativePath: "Excalidraw/Map 2026-04-05.excalidraw",
        history: [],
        historyIndex: -1,
    };
    const layoutTree = splitPane(
        createInitialLayout("primary"),
        "primary",
        "row",
        "secondary",
    );

    useEditorStore.setState({
        panes: [
            {
                id: "primary",
                tabs: [homeTab],
                tabIds: [homeTab.id],
                activeTabId: homeTab.id,
                activationHistory: [homeTab.id],
                tabNavigationHistory: [homeTab.id],
                tabNavigationIndex: 0,
            },
            {
                id: "secondary",
                tabs: [mapTab],
                tabIds: [mapTab.id],
                activeTabId: mapTab.id,
                activationHistory: [mapTab.id],
                tabNavigationHistory: [mapTab.id],
                tabNavigationIndex: 0,
            },
        ],
        focusedPaneId: "primary",
        layoutTree,
        tabs: [homeTab],
        activeTabId: homeTab.id,
        activationHistory: [homeTab.id],
        tabNavigationHistory: [homeTab.id],
        tabNavigationIndex: 0,
    });
}

describe("MapsPanel", () => {
    it("renames a map from the context menu while preserving the map tab linkage in another pane", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        useVaultStore.setState({ vaultPath: "/vault" });
        setFocusedPrimaryWorkspaceWithMapInSecondary();

        invokeMock.mockImplementation(async (command) => {
            if (command === "list_maps") {
                return [
                    buildMapListEntry(
                        "Excalidraw/Map 2026-04-05.excalidraw",
                        "Map 2026-04-05",
                    ),
                ];
            }
            if (command === "move_vault_entry") {
                return buildMovedMapEntry(
                    "Excalidraw/Architecture.excalidraw",
                    "Architecture",
                );
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<MapsPanel />);
        await flushPromises();

        const mapRow = screen.getByText("Map 2026-04-05").closest("button");
        expect(mapRow).not.toBeNull();

        fireEvent.contextMenu(mapRow!, {
            clientX: 40,
            clientY: 40,
        });

        await user.click(await screen.findByText("Rename"));

        const renameInput = await screen.findByLabelText(
            "Rename Map 2026-04-05",
        );
        await user.clear(renameInput);
        await user.type(renameInput, "Architecture{Enter}");

        await waitFor(() => {
            expect(invokeMock).toHaveBeenCalledWith("move_vault_entry", {
                vaultPath: "/vault",
                relativePath: "Excalidraw/Map 2026-04-05.excalidraw",
                newRelativePath: "Excalidraw/Architecture.excalidraw",
            });
        });

        expect(await screen.findByText("Architecture")).toBeInTheDocument();
        const mapTabs = useEditorStore
            .getState()
            .panes.flatMap((pane) => pane.tabs)
            .filter((tab) => isMapTab(tab));
        expect(mapTabs).toHaveLength(1);
        expect(mapTabs[0]).toMatchObject({
            relativePath: "Excalidraw/Architecture.excalidraw",
            title: "Architecture",
        });
        expect(useEditorStore.getState().focusedPaneId).toBe("primary");
    });

    it("deletes a map from the context menu and closes its open tab in another pane", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        useVaultStore.setState({ vaultPath: "/vault" });
        setFocusedPrimaryWorkspaceWithMapInSecondary();

        invokeMock.mockImplementation(async (command) => {
            if (command === "list_maps") {
                return [
                    buildMapListEntry(
                        "Excalidraw/Map 2026-04-05.excalidraw",
                        "Map 2026-04-05",
                    ),
                ];
            }
            if (command === "delete_map") {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<MapsPanel />);
        await flushPromises();

        const mapRow = screen.getByText("Map 2026-04-05").closest("button");
        expect(mapRow).not.toBeNull();

        fireEvent.contextMenu(mapRow!, {
            clientX: 50,
            clientY: 50,
        });

        await user.click(await screen.findByText("Delete Map"));

        await waitFor(() => {
            expect(invokeMock).toHaveBeenCalledWith("delete_map", {
                vaultPath: "/vault",
                relativePath: "Excalidraw/Map 2026-04-05.excalidraw",
            });
        });

        await waitFor(() => {
            expect(
                screen.queryByText("Map 2026-04-05"),
            ).not.toBeInTheDocument();
        });
        expect(
            useEditorStore
                .getState()
                .panes.flatMap((pane) => pane.tabs)
                .some((tab) => isMapTab(tab)),
        ).toBe(false);
        expect(useEditorStore.getState().focusedPaneId).toBe("primary");
    });
});
