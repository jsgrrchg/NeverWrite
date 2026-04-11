import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderComponent, setEditorTabs } from "../../test/test-utils";
import { WorkspaceChromeBar } from "./WorkspaceChromeBar";

describe("WorkspaceChromeBar", () => {
    it("preserves the unified navigation chrome when split view is active", () => {
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

        const backButton = screen.getByTitle("Go back");
        const forwardButton = screen.getByTitle("Go forward");

        expect(backButton).toHaveStyle({
            border: "1px solid var(--border)",
            borderRight: "none",
            backgroundColor: "var(--bg-secondary)",
            cursor: "default",
        });
        expect(backButton).toHaveStyle({
            boxShadow: "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
        });
        expect(forwardButton).toHaveStyle({
            border: "1px solid var(--border)",
            backgroundColor: "var(--bg-secondary)",
            cursor: "default",
        });
        expect(forwardButton).toHaveStyle({
            boxShadow: "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
        });
    });
});
