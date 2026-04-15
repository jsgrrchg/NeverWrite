import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
    createInitialLayout,
    splitPane,
} from "../../app/store/workspaceLayoutTree";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { useChatStore } from "../ai/store/chatStore";
import { WorkspacePaneEmptyState } from "./WorkspacePaneEmptyState";

describe("WorkspacePaneEmptyState", () => {
    beforeEach(() => {
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: "/vault",
        }));
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [
                {
                    runtime: {
                        id: "codex-acp",
                        name: "Codex ACP",
                    },
                },
            ] as typeof state.runtimes,
        }));
    });

    it("shows quick actions for the last empty pane", () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
        );

        renderComponent(<WorkspacePaneEmptyState paneId="primary" />);

        expect(screen.getByText("Empty Pane")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "New Note" })).toBeVisible();
        expect(screen.getByRole("button", { name: "New Agent" })).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Close Pane" }),
        ).not.toBeInTheDocument();
    });

    it("lets the user close an empty secondary pane", async () => {
        const user = userEvent.setup();
        useEditorStore.setState({
            panes: [
                {
                    id: "primary",
                    tabs: [],
                    tabIds: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                },
                {
                    id: "secondary",
                    tabs: [],
                    tabIds: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                },
            ],
            focusedPaneId: "secondary",
            layoutTree: splitPane(
                createInitialLayout("primary"),
                "primary",
                "row",
                "secondary",
            ),
        });

        renderComponent(<WorkspacePaneEmptyState paneId="secondary" />);

        await user.click(screen.getByRole("button", { name: "Close Pane" }));

        expect(useEditorStore.getState().panes.map((pane) => pane.id)).toEqual([
            "primary",
        ]);
    });
});
