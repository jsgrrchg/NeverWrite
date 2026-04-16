import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { renderComponent } from "../../test/test-utils";
import { WorkspacePaneEmptyState } from "./WorkspacePaneEmptyState";

describe("WorkspacePaneEmptyState", () => {
    beforeEach(() => {
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
    });

    it("shows a compact empty state message", () => {
        renderComponent(<WorkspacePaneEmptyState paneId="primary" />);

        expect(
            screen.getByText("Open a file, start a chat or launch a terminal."),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "New Note" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "New Agent" }),
        ).not.toBeInTheDocument();
    });

    it("keeps pane identity marker for drop and targeting logic", () => {
        renderComponent(<WorkspacePaneEmptyState paneId="secondary" />);

        expect(
            document.querySelector("[data-workspace-empty-pane='secondary']"),
        ).toBeInTheDocument();
    });
});
