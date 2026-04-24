import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@neverwrite/runtime";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultEntries,
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
    it("renders relative markdown note links as internal file pills", () => {
        setVaultNotes([
            {
                id: "README.md",
                title: "README",
                path: "/vault/README.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(
            <MarkdownContent
                content="En [README](README.md) pone lo mismo."
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "README" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("link", { name: "README" }),
        ).not.toBeInTheDocument();
    });

    it("opens relative markdown text file links in a new tab from the context menu", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "apps/web-clipper/package.json",
                });
                return {
                    path: "/vault/apps/web-clipper/package.json",
                    relative_path: "apps/web-clipper/package.json",
                    file_name: "package.json",
                    mime_type: "application/json",
                    content: '{ "name": "web-clipper" }',
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        setVaultEntries([
            {
                id: "apps/web-clipper/package.json",
                path: "/vault/apps/web-clipper/package.json",
                relative_path: "apps/web-clipper/package.json",
                title: "package.json",
                file_name: "package.json",
                extension: "json",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 32,
                mime_type: "application/json",
            },
        ]);

        renderComponent(
            <MarkdownContent
                content="Coincide con [apps/web-clipper/package.json](apps/web-clipper/package.json)."
                pillMetrics={pillMetrics}
            />,
        );

        fireEvent.contextMenu(
            screen.getByRole("button", { name: "package.json" }),
            {
                clientX: 28,
                clientY: 32,
            },
        );
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(1);
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            kind: "file",
            title: "package.json",
            path: "/vault/apps/web-clipper/package.json",
        });
    });

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

    it("opens text file pills in a new tab from the context menu", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "src/main.ts",
                });
                return {
                    path: "/vault/src/main.ts",
                    relative_path: "src/main.ts",
                    file_name: "main.ts",
                    mime_type: "text/typescript",
                    content: "export const value = 1;",
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        setVaultEntries([
            {
                id: "src/main.ts",
                path: "/vault/src/main.ts",
                relative_path: "src/main.ts",
                title: "main.ts",
                file_name: "main.ts",
                extension: "ts",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 32,
                mime_type: "text/typescript",
            },
        ]);

        renderComponent(
            <MarkdownContent
                content="Review `/vault/src/main.ts`."
                pillMetrics={pillMetrics}
            />,
        );

        fireEvent.contextMenu(screen.getByRole("button", { name: "main.ts" }), {
            clientX: 28,
            clientY: 32,
        });
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(1);
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            kind: "file",
            title: "main.ts",
            path: "/vault/src/main.ts",
        });
    });

    it("renders text file pills even before the vault entries store refreshes", () => {
        setVaultEntries([]);

        renderComponent(
            <MarkdownContent
                content="Review `/vault/src/main.ts`."
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "main.ts" }),
        ).toBeInTheDocument();
    });

    it("does not crash on markdown links with malformed URI encoding", () => {
        renderComponent(
            <MarkdownContent
                content="Use [100% notes](/vault/100% notes.md)."
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "100% notes" }),
        ).toBeInTheDocument();
    });

    it("does not crash on absolute vault file paths with literal percent signs", () => {
        renderComponent(
            <MarkdownContent
                content="Open `/vault/100% notes.md`."
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "100% notes" }),
        ).toBeInTheDocument();
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

        expect(
            screen.getByText((_content, node) => node?.tagName === "CODE"),
        ).toHaveTextContent(/-beta\s+\+beta 2/);
    });

    it("renders syntax highlighting for fenced programming code blocks", async () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "```c++",
                    "int main() {",
                    "  return 0;",
                    "}",
                    "```",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.getByText("c++")).toBeInTheDocument();

        await waitFor(() => {
            expect(
                document.querySelector(".cm-static-token-keyword"),
            ).not.toBeNull();
        });

        expect(screen.getByText("return")).toHaveClass(
            "cm-static-token-keyword",
        );
    });

    it("renders markdown tables as semantic table markup", () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "| File | Status |",
                    "| --- | --- |",
                    "| watcher.rs | Done |",
                    "| parser.rs | Pending |",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.getByRole("table")).toBeInTheDocument();
        expect(
            screen.getByRole("columnheader", { name: "File" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("cell", { name: "watcher.rs" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("cell", { name: "Pending" }),
        ).toBeInTheDocument();
    });

    it("prefers cell wrapping over expanding markdown tables horizontally", () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "| File | Notes |",
                    "| --- | --- |",
                    "| watcher.rs | This cell should wrap across multiple lines instead of forcing the table wider than the chat column. |",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        const table = screen.getByRole("table");
        const header = screen.getByRole("columnheader", { name: "Notes" });
        const cell = screen.getByRole("cell", {
            name: /This cell should wrap across multiple lines/i,
        });

        expect(table).toHaveStyle({
            width: "100%",
            tableLayout: "fixed",
        });
        expect(header).toHaveStyle({
            overflowWrap: "anywhere",
            wordBreak: "break-word",
        });
        expect(cell).toHaveStyle({
            overflowWrap: "anywhere",
            wordBreak: "break-word",
        });
    });

    it("renders inline markdown inside table cells", () => {
        setVaultNotes([
            {
                id: "docs/guide.md",
                title: "guide",
                path: "/vault/docs/guide.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(
            <MarkdownContent
                content={[
                    "| Note | State |",
                    "| --- | --- |",
                    "| `/vault/docs/guide.md` | **Ready** |",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "guide" }),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Ready", { selector: "strong" }),
        ).toBeInTheDocument();
    });

    it("does not mistake plain pipe-separated text for a markdown table", () => {
        renderComponent(
            <MarkdownContent
                content="status | pending | review"
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        expect(
            screen.getByText("status | pending | review"),
        ).toBeInTheDocument();
    });
});
