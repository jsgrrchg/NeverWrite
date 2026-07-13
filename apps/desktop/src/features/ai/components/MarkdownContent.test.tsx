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
    it("renders inline pills with full wrapping labels", () => {
        const longLabel =
            "2026 - The Case for No Reliable Narrator in Long Research Notes";

        renderComponent(
            <MarkdownContent
                content={`Review [[${longLabel}]].`}
                pillMetrics={pillMetrics}
            />,
        );

        const pill = screen.getByRole("button", { name: longLabel });
        const label = pill.querySelector("span > span");

        expect(pill).toBeInTheDocument();
        expect(label).toHaveTextContent(longLabel);
        expect(label).toHaveStyle({
            overflowWrap: "anywhere",
            whiteSpace: "normal",
            wordBreak: "break-word",
        });
    });

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

    it("resolves unique extensionless note links and preserves line targets", async () => {
        const title = "Petróleo - Ficha de análisis";
        setVaultNotes([
            {
                id: "Análisis/Petróleo - Ficha de análisis.md",
                title,
                path: "/vault/Análisis/Petróleo - Ficha de análisis.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "petroleo-tab",
                noteId: "Análisis/Petróleo - Ficha de análisis.md",
                title,
                content: "# Petróleo",
            },
        ]);

        renderComponent(
            <MarkdownContent
                content={`Revisa [${title}](${encodeURIComponent(title)}#L66).`}
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        const reference = screen.getByRole("button", {
            name: `${title} (line 66)`,
        });
        expect(reference).toHaveStyle({
            background: "transparent",
            padding: "0px",
        });
        const icon = reference.querySelector("svg");
        expect(icon).not.toBeNull();
        expect(reference.firstElementChild).toHaveStyle({
            alignItems: "flex-start",
        });
        expect(icon?.parentElement).toHaveStyle({ height: "1.3em" });

        fireEvent.click(reference);
        await waitFor(() => {
            expect(useEditorStore.getState().pendingLineReveal).toEqual({
                noteId: "Análisis/Petróleo - Ficha de análisis.md",
                line: 66,
                endLine: null,
            });
        });
    });

    it("does not choose an arbitrary extensionless note when titles are ambiguous", () => {
        setVaultNotes([
            {
                id: "research/Brief.md",
                title: "Brief",
                path: "/vault/research/Brief.md",
                modified_at: 0,
                created_at: 0,
            },
            {
                id: "archive/Brief.md",
                title: "Brief",
                path: "/vault/archive/Brief.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(
            <MarkdownContent
                content="See [Brief](Brief)."
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        expect(document.body).toHaveTextContent("See Brief.");
        expect(screen.queryByRole("button", { name: "Brief" })).toBeNull();
        expect(screen.queryByRole("link", { name: "Brief" })).toBeNull();
    });

    it("keeps unresolved relative markdown links non-interactive", () => {
        setVaultNotes([]);

        renderComponent(
            <MarkdownContent
                content="See [missing note](missing-note)."
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        expect(document.body).toHaveTextContent("See missing note.");
        expect(
            screen.queryByRole("link", { name: "missing note" }),
        ).toBeNull();
    });

    it("does not reinterpret external file-like URLs as vault references", () => {
        renderComponent(
            <MarkdownContent
                content="Read [PDF docs](https://example.com/guide.pdf)."
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.getByRole("link", { name: "PDF docs" })).toHaveAttribute(
            "href",
            "https://example.com/guide.pdf",
        );
        expect(screen.queryByRole("button", { name: "PDF docs" })).toBeNull();
    });

    it("renders chat file references as icon-led links", () => {
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
                content="Read [main.ts](src/main.ts)."
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        const reference = screen.getByRole("button", { name: "main.ts" });
        expect(reference).toHaveStyle({
            background: "transparent",
            padding: "0px",
        });
        expect(reference.querySelector("svg")).not.toBeNull();
    });

    it("renders line fragments in the shared style and reveals note lines", async () => {
        setVaultNotes([
            {
                id: "CHANGELOG.md",
                title: "CHANGELOG",
                path: "/vault/CHANGELOG.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "changelog-tab",
                noteId: "CHANGELOG.md",
                title: "CHANGELOG",
                content: "# Changelog",
            },
        ]);

        renderComponent(
            <MarkdownContent
                content="See [CHANGELOG.md](CHANGELOG.md#L66)."
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        const reference = screen.getByRole("button", {
            name: "CHANGELOG.md (line 66)",
        });
        expect(reference).toHaveStyle({
            background: "transparent",
            padding: "0px",
        });
        expect(reference.querySelector("svg")).not.toBeNull();

        fireEvent.click(reference);
        await waitFor(() => {
            expect(useEditorStore.getState().pendingLineReveal).toEqual({
                noteId: "CHANGELOG.md",
                line: 66,
                endLine: null,
            });
        });
    });

    it("renders line ranges for absolute text file references", () => {
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
                content="See `/vault/src/main.ts#L10-L12`."
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "main.ts (lines 10–12)" }),
        ).toBeInTheDocument();
    });

    it("renders indexed folders as non-interactive icon links in every supported syntax", () => {
        setVaultEntries([
            {
                id: "docs",
                path: "/vault/docs",
                relative_path: "docs",
                title: "docs",
                file_name: "docs",
                extension: "",
                kind: "folder",
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: null,
            },
        ]);

        const { container } = renderComponent(
            <MarkdownContent
                content="Inline `/vault/docs`, [docs](docs), and /vault/docs"
                fileReferenceAppearance="link"
                pillMetrics={pillMetrics}
            />,
        );

        const folders = container.querySelectorAll<HTMLElement>(
            '[title="docs"], [title="/vault/docs"]',
        );
        expect(folders).toHaveLength(3);
        expect(container.querySelectorAll('button[title="docs"]')).toHaveLength(
            0,
        );
        expect(
            container.querySelectorAll('button[title="/vault/docs"]'),
        ).toHaveLength(0);
        for (const folder of folders) {
            expect(folder).toHaveStyle({
                background: "transparent",
                padding: "0px",
            });
            expect(folder.querySelector("svg")).not.toBeNull();
        }
    });

    it("renders raw http and https URLs as external links", () => {
        renderComponent(
            <MarkdownContent
                content="Read https://example.com/docs and try http://localhost:3000."
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("link", { name: "https://example.com/docs" }),
        ).toHaveAttribute("href", "https://example.com/docs");
        expect(
            screen.getByRole("link", { name: "http://localhost:3000" }),
        ).toHaveAttribute("href", "http://localhost:3000");
        expect(document.body).toHaveTextContent("http://localhost:3000.");
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
                fileReferenceAppearance="link"
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

    it("keeps slash tokens in prose as plain text unless they resolve to vault references", () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "Läuft euer S/4 in der Public Cloud?",
                    "Viele Schaltanlagenbauer /EVU-Partner gehen in unsere Richtung.",
                    "TCP/IP ist der Standard.",
                    "Zielquartal ist 2024/Q1.",
                    "Kontakt über /LinkedIn.",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.queryByRole("button", { name: "/4" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "/EVU-Partner" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "/IP" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "/Q1" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "/LinkedIn" }),
        ).not.toBeInTheDocument();

        expect(document.body).toHaveTextContent("S/4");
        expect(document.body).toHaveTextContent("/EVU-Partner");
        expect(document.body).toHaveTextContent("TCP/IP");
        expect(document.body).toHaveTextContent("2024/Q1");
        expect(document.body).toHaveTextContent("/LinkedIn");
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

        expect(screen.getByText("C++").parentElement).toHaveClass(
            "chat-code-header",
        );

        await waitFor(() => {
            expect(
                document.querySelector(".cm-static-token-keyword"),
            ).not.toBeNull();
        });

        expect(screen.getByText("return")).toHaveClass(
            "cm-static-token-keyword",
        );
    });

    it("uses the compact Comando frame for chat code fences", () => {
        const { container } = renderComponent(
            <MarkdownContent
                content={["```bash", "git status", "```"].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        expect(screen.getByText("Bash").parentElement).toHaveClass(
            "chat-code-header",
        );
        expect(screen.getByRole("button", { name: "Copy code block" })).toHaveClass(
            "chat-code-copy-button",
        );
        expect(container.querySelector(".chat-code-frame")).not.toBeNull();
        expect(container.querySelector(".chat-code-block")).not.toBeNull();
    });

    it("previews markdown fences and lets the user inspect their source", () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "```markdown",
                    "# Rendered heading",
                    "",
                    "1. First item",
                    "2. Second item",
                    "```",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        const preview = screen.getByTestId("chat-markdown-preview");
        expect(preview).toHaveTextContent("Rendered heading");
        expect(preview.querySelector(".nw-md-heading")).toHaveTextContent(
            "Rendered heading",
        );
        expect(preview.querySelector("ol")).toHaveTextContent(
            "First itemSecond item",
        );
        const toggle = screen.getByRole("button", {
            name: "Toggle markdown display mode",
        });
        expect(toggle).toHaveAttribute("title", "Show source");

        fireEvent.click(toggle);

        expect(screen.queryByTestId("chat-markdown-preview")).toBeNull();
        expect(
            screen.getByRole("button", {
                name: "Toggle markdown display mode",
            }),
        ).toHaveAttribute("title", "Show preview");
        expect(screen.getByText((_text, node) => node?.tagName === "CODE")).toHaveTextContent(
            /# Rendered heading.*1\. First item.*2\. Second item/s,
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

    it("preserves ordered list markers when paragraphs split list items", () => {
        renderComponent(
            <MarkdownContent
                content={[
                    "1. First pressure point",
                    "The first point has explanatory text.",
                    "",
                    "2. Second pressure point",
                    "The second point should not render as item one.",
                    "",
                    "3. Third pressure point",
                    "The third point should keep its marker too.",
                ].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        const orderedLists = Array.from(document.querySelectorAll("ol"));
        expect(orderedLists).toHaveLength(3);
        expect(orderedLists.map((list) => list.start)).toEqual([1, 2, 3]);

        expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });

    it("keeps browser auto-numbering for repeated ordered list markers", () => {
        renderComponent(
            <MarkdownContent
                content={["1. First", "1. Second", "1. Third"].join("\n")}
                pillMetrics={pillMetrics}
            />,
        );

        const orderedLists = Array.from(document.querySelectorAll("ol"));
        expect(orderedLists).toHaveLength(1);
        expect(orderedLists[0].start).toBe(1);
        expect(
            screen
                .getAllByRole("listitem")
                .every((item) => !item.hasAttribute("value")),
        ).toBe(true);
    });
});
