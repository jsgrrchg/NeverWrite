import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../../test/test-utils";
import { MarkdownContent } from "./MarkdownContent";

const pillMetrics = {
    fontSize: 12,
    lineHeight: 1.3,
    paddingX: 8,
    paddingY: 2,
    radius: 8,
    gapX: 2,
    maxWidth: 180,
    offsetY: 0,
};

describe("MarkdownContent", () => {
    it("opens markdown file pills in a new tab from the context menu", async () => {
        setVaultNotes([
            {
                id: "docs/primera-utilidad.md",
                title: "primera-utilidad",
                path: "/vault/docs/primera-utilidad.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-existing",
                noteId: "docs/primera-utilidad.md",
                title: "primera-utilidad",
                content: "# primera utilidad",
            },
        ]);

        renderComponent(
            <MarkdownContent
                content="Revisa `/vault/docs/primera-utilidad.md`."
                pillMetrics={pillMetrics}
            />,
        );

        fireEvent.contextMenu(
            screen.getByRole("button", { name: "primera-utilidad" }),
            {
                clientX: 28,
                clientY: 32,
            },
        );
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });
    });

    it("renders unified diff code blocks with exact line gutters", () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "```diff",
                    "@@ -10,2 +10,3 @@",
                    " alpha",
                    "-beta",
                    "+beta 2",
                    " gamma",
                    "```",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.getAllByText("10")).toHaveLength(2);
        expect(screen.getByText("beta 2")).toBeInTheDocument();
        expect(screen.queryByText("+beta 2")).not.toBeInTheDocument();
        expect(screen.queryByText("-beta")).not.toBeInTheDocument();
    });

    it("falls back to plain rendering for diff code blocks without hunk headers", () => {
        renderComponent(
            <MarkdownContent
                content={["```diff", "-beta", "+beta 2", "```"].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.getByText((_content, node) => node?.tagName === "CODE"))
            .toHaveTextContent(/-beta\s+\+beta 2/);
    });
});
