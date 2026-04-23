import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { mockInvoke, renderComponent } from "../../test/test-utils";
import { ExcalidrawTabView } from "./ExcalidrawTabView";

vi.mock("@excalidraw/excalidraw", async () => {
    const React = await import("react");

    return {
        Excalidraw: ({
            initialData,
        }: {
            initialData: { forRelativePath?: string };
        }) =>
            React.createElement(
                "div",
                {
                    "data-testid": `excalidraw-map-${initialData.forRelativePath}`,
                },
                initialData.forRelativePath,
            ),
        getSceneVersion: () => 1,
        serializeAsJSON: () => "{}",
    };
});

describe("ExcalidrawTabView", () => {
    it("loads the active map for its own pane instead of the focused pane", async () => {
        const invokeMock = mockInvoke();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_map") {
                return JSON.stringify({
                    elements: [],
                    appState: {
                        viewBackgroundColor:
                            typeof args?.relativePath === "string"
                                ? args.relativePath
                                : "",
                    },
                    files: {},
                });
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        useVaultStore.setState({ vaultPath: "/vault" });
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "map-a",
                            kind: "map",
                            relativePath: "Excalidraw/A.excalidraw",
                            title: "Map A",
                        },
                    ],
                    activeTabId: "map-a",
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: "map-b",
                            kind: "map",
                            relativePath: "Excalidraw/B.excalidraw",
                            title: "Map B",
                        },
                    ],
                    activeTabId: "map-b",
                },
            ],
            "secondary",
        );

        renderComponent(
            <>
                <ExcalidrawTabView paneId="primary" />
                <ExcalidrawTabView paneId="secondary" />
            </>,
        );

        expect(
            await screen.findByTestId(
                "excalidraw-map-Excalidraw/A.excalidraw",
            ),
        ).toHaveTextContent("Excalidraw/A.excalidraw");
        expect(
            await screen.findByTestId(
                "excalidraw-map-Excalidraw/B.excalidraw",
            ),
        ).toHaveTextContent("Excalidraw/B.excalidraw");

        await waitFor(() => {
            expect(invokeMock).toHaveBeenCalledWith("read_map", {
                vaultPath: "/vault",
                relativePath: "Excalidraw/A.excalidraw",
            });
            expect(invokeMock).toHaveBeenCalledWith("read_map", {
                vaultPath: "/vault",
                relativePath: "Excalidraw/B.excalidraw",
            });
        });
    });
});
