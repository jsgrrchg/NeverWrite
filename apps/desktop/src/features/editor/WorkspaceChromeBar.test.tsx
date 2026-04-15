import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderComponent, setEditorTabs } from "../../test/test-utils";
import { WorkspaceChromeBar } from "./WorkspaceChromeBar";

describe("WorkspaceChromeBar", () => {
    it("keeps the top chrome free of pane-local navigation", () => {
        setEditorTabs(
            [
                {
                    id: "tab-a",
                    kind: "note",
                    noteId: "notes/alpha.md",
                    title: "Alpha",
                    content: "alpha",
                },
            ],
            "tab-a",
        );

        renderComponent(<WorkspaceChromeBar />);

        expect(screen.queryByTitle("Go back")).not.toBeInTheDocument();
        expect(screen.queryByTitle("Go forward")).not.toBeInTheDocument();
        expect(screen.getByTitle("Hide sidebar")).toBeInTheDocument();
    });

    it("uses the shared trailing panel controls chrome in split view", () => {
        setEditorTabs(
            [
                {
                    id: "tab-a",
                    kind: "note",
                    noteId: "notes/alpha.md",
                    title: "Alpha",
                    content: "alpha",
                },
            ],
            "tab-a",
        );

        renderComponent(<WorkspaceChromeBar />);

        const chatButton = screen.getByTitle("AI Chat");
        const outlineButton = screen.getByTitle("Outline panel");
        const linksButton = screen.getByTitle("Links panel");
        const group = chatButton.parentElement;

        expect(group).not.toBeNull();
        expect(group).toHaveStyle({
            display: "flex",
            alignItems: "center",
            borderRadius: "12px",
            padding: "0 3px",
        });
        expect(chatButton).toHaveClass(
            "ub-chrome-btn",
            "flex",
            "items-center",
            "justify-center",
            "shrink-0",
        );
        expect(outlineButton).toHaveClass("ub-chrome-btn");
        expect(linksButton).toHaveClass("ub-chrome-btn");
    });
});
