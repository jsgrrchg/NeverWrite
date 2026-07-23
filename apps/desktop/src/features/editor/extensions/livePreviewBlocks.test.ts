/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getFencedCodeBlockKind,
    resolvePreviewAssetPath,
} from "./livePreviewBlocks";
import { livePreviewExtension } from "./livePreview";
import { renderMermaidDiagram } from "../mermaid/mermaidRenderer";

vi.mock("../mermaid/mermaidRenderer", () => ({
    renderMermaidDiagram: vi.fn(),
}));

const mockedRenderMermaidDiagram = vi.mocked(renderMermaidDiagram);

function createLivePreviewState(doc: string, cursor = doc.length) {
    return EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [
            markdown({ base: markdownLanguage }),
            livePreviewExtension(null, {
                resolveWikilink: () => false,
                navigateWikilink: () => {},
                getNoteLinkTarget: () => null,
                openLinkContextMenu: () => {},
            }),
        ],
    });
}

function flushPromises() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function createDeferredRender() {
    let resolve!: (value: Awaited<ReturnType<typeof renderMermaidDiagram>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof renderMermaidDiagram>>>(
        (resolver) => {
            resolve = resolver;
        },
    );
    return { promise, resolve };
}

beforeEach(() => {
    mockedRenderMermaidDiagram.mockReset();
});

describe("resolvePreviewAssetPath", () => {
    it("resolves note-relative assets against the current note path", () => {
        expect(
            resolvePreviewAssetPath(
                "./assets/cover.png",
                "/vault",
                "/vault/notes/daily/today.md",
            ),
        ).toBe("/vault/notes/daily/assets/cover.png");
    });

    it("supports parent-directory traversal from the current note", () => {
        expect(
            resolvePreviewAssetPath(
                "../shared/diagram.png",
                "/vault",
                "/vault/notes/daily/today.md",
            ),
        ).toBe("/vault/notes/shared/diagram.png");
    });

    it("keeps vault-root-relative assets anchored to the vault root", () => {
        expect(
            resolvePreviewAssetPath(
                "/attachments/diagram.png",
                "/vault",
                "/vault/notes/daily/today.md",
            ),
        ).toBe("/vault/attachments/diagram.png");
    });
});

describe("code block live preview", () => {
    it("classifies Mermaid info strings separately from regular code blocks", () => {
        expect(getFencedCodeBlockKind("mermaid")).toBe("mermaid");
        expect(getFencedCodeBlockKind(" mermaid")).toBe("mermaid");
        expect(getFencedCodeBlockKind('mermaid title="Flow"')).toBe("mermaid");
        expect(getFencedCodeBlockKind("Mermaid")).toBe("mermaid");
        expect(getFencedCodeBlockKind("typescript")).toBe("code");
        expect(getFencedCodeBlockKind("")).toBe("code");
    });

    it("compacts inactive blank lines around rendered tables", () => {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc = [
            "## Table",
            "",
            "| A | B |",
            "| --- | --- |",
            "| 1 | 2 |",
            "",
            "After",
        ].join("\n");
        const state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(0),
            extensions: [
                markdown({ base: markdownLanguage }),
                livePreviewExtension(null, {
                    resolveWikilink: () => false,
                    navigateWikilink: () => {},
                    getNoteLinkTarget: () => null,
                    openLinkContextMenu: () => {},
                }),
            ],
        });

        const view = new EditorView({ state, parent });

        expect(view.dom.querySelector(".cm-lp-table-widget")).not.toBeNull();
        const blankLines = [...view.dom.querySelectorAll(".cm-line")].filter(
            (line) => line.textContent?.trim() === "",
        );
        expect(blankLines).toHaveLength(2);
        expect(
            blankLines.every((line) =>
                line.classList.contains("cm-lp-block-gap-hidden"),
            ),
        ).toBe(true);

        view.destroy();
        parent.remove();
    });

    it("marks Mermaid fenced code blocks without affecting regular fences", () => {
        mockedRenderMermaidDiagram.mockResolvedValue({
            status: "ok",
            svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        });
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc = [
            "```mermaid",
            "flowchart TD",
            "  A --> B",
            "```",
            "",
            "```ts",
            "const value = 1;",
            "```",
        ].join("\n");
        const state = createLivePreviewState(doc);

        const view = new EditorView({ state, parent });
        const headers = [
            ...view.dom.querySelectorAll<HTMLElement>(".cm-code-block-header"),
        ];

        expect(view.dom.querySelector(".cm-mermaid-preview")).not.toBeNull();
        expect(headers).toHaveLength(1);
        expect(headers[0].dataset.codeBlockKind).toBe("code");
        expect(headers[0].textContent).toContain("TypeScript");

        view.destroy();
        parent.remove();
    });

    it("does not mark incomplete Mermaid fences as rendered blocks", () => {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc = ["```mermaid", "flowchart TD", "  A --> B"].join("\n");
        const state = createLivePreviewState(doc);

        const view = new EditorView({ state, parent });

        expect(view.dom.querySelector(".cm-mermaid-preview")).toBeNull();
        expect(mockedRenderMermaidDiagram).not.toHaveBeenCalled();

        view.destroy();
        parent.remove();
    });

    it("renders Mermaid SVG blocks asynchronously", async () => {
        mockedRenderMermaidDiagram.mockResolvedValueOnce({
            status: "ok",
            svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
        });
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc = ["```mermaid", "flowchart TD", "  A --> B", "```"].join(
            "\n",
        );
        const view = new EditorView({
            state: createLivePreviewState(doc),
            parent,
        });

        const preview = view.dom.querySelector(".cm-mermaid-preview");
        expect(preview?.textContent).toContain("Rendering Mermaid diagram...");
        expect(mockedRenderMermaidDiagram).toHaveBeenCalledWith(
            "flowchart TD\n  A --> B",
            expect.stringMatching(/^mermaid-\d+-0-[a-z0-9]+$/),
        );

        await flushPromises();

        expect(
            view.dom.querySelector(".cm-mermaid-preview svg text")?.textContent,
        ).toBe("Diagram");
        expect(view.dom.querySelector(".cm-mermaid-preview-error")).toBeNull();

        view.destroy();
        parent.remove();
    });

    it("renders multiple Mermaid diagrams independently", async () => {
        mockedRenderMermaidDiagram
            .mockResolvedValueOnce({
                status: "ok",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>First</text></svg>',
            })
            .mockResolvedValueOnce({
                status: "ok",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Second</text></svg>',
            });
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const first = ["```mermaid", "flowchart TD", "  A --> B", "```"].join(
            "\n",
        );
        const second = [
            "```mermaid",
            "sequenceDiagram",
            "  Alice->>Bob: Hi",
            "```",
        ].join("\n");
        const view = new EditorView({
            state: createLivePreviewState(`${first}\n\n${second}`),
            parent,
        });

        await flushPromises();

        const renderedLabels = [
            ...view.dom.querySelectorAll(".cm-mermaid-preview svg text"),
        ].map((node) => node.textContent);

        expect(renderedLabels).toEqual(["First", "Second"]);
        expect(mockedRenderMermaidDiagram).toHaveBeenNthCalledWith(
            1,
            "flowchart TD\n  A --> B",
            expect.stringMatching(/^mermaid-\d+-0-[a-z0-9]+$/),
        );
        expect(mockedRenderMermaidDiagram).toHaveBeenNthCalledWith(
            2,
            "sequenceDiagram\n  Alice->>Bob: Hi",
            expect.stringMatching(/^mermaid-\d+-\d+-[a-z0-9]+$/),
        );

        view.destroy();
        parent.remove();
    });

    it("ignores stale Mermaid renders after rapid edits", async () => {
        const firstRender = createDeferredRender();
        mockedRenderMermaidDiagram
            .mockReturnValueOnce(firstRender.promise)
            .mockResolvedValueOnce({
                status: "ok",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Updated</text></svg>',
            });
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const initialDoc = [
            "```mermaid",
            "flowchart TD",
            "  A --> B",
            "```",
        ].join("\n");
        const view = new EditorView({
            state: createLivePreviewState(initialDoc),
            parent,
        });

        const updatedDoc = [
            "```mermaid",
            "flowchart TD",
            "  A --> C",
            "```",
        ].join("\n");
        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: updatedDoc,
            },
        });

        await flushPromises();

        firstRender.resolve({
            status: "ok",
            svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Stale</text></svg>',
        });
        await flushPromises();

        expect(
            view.dom.querySelector(".cm-mermaid-preview svg text")?.textContent,
        ).toBe("Updated");
        expect(view.dom.textContent).not.toContain("Stale");

        view.destroy();
        parent.remove();
    });

    it("rerenders Mermaid blocks after text-only edits inside the diagram", async () => {
        mockedRenderMermaidDiagram
            .mockResolvedValueOnce({
                status: "ok",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Original</text></svg>',
            })
            .mockResolvedValueOnce({
                status: "ok",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Updated</text></svg>',
            });
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc = ["```mermaid", "flowchart TD", "  A --> B", "```"].join(
            "\n",
        );
        const view = new EditorView({
            state: createLivePreviewState(doc),
            parent,
        });

        await flushPromises();

        const from = doc.indexOf("B");
        view.dispatch({
            changes: {
                from,
                to: from + 1,
                insert: "C",
            },
        });

        await flushPromises();

        expect(
            view.dom.querySelector(".cm-mermaid-preview svg text")?.textContent,
        ).toBe("Updated");
        expect(mockedRenderMermaidDiagram).toHaveBeenNthCalledWith(
            2,
            "flowchart TD\n  A --> C",
            expect.stringMatching(/^mermaid-\d+-0-[a-z0-9]+$/),
        );

        view.destroy();
        parent.remove();
    });

    it("shows Mermaid render errors inline", async () => {
        mockedRenderMermaidDiagram.mockResolvedValueOnce({
            status: "error",
            message: "Parse error",
        });
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc = ["```mermaid", "not a diagram", "```"].join("\n");
        const view = new EditorView({
            state: createLivePreviewState(doc),
            parent,
        });

        await flushPromises();

        expect(
            view.dom.querySelector(".cm-mermaid-preview-error-title")
                ?.textContent,
        ).toBe("Mermaid diagram error");
        expect(
            view.dom.querySelector(".cm-mermaid-preview-error-message")
                ?.textContent,
        ).toBe("Parse error");

        view.destroy();
        parent.remove();
    });

    it("renders tables when the markdown parser finishes after editor creation", () => {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const filler = "plain text ".repeat(420);
        const table = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
        const doc = `${filler}\n\n${table}`;
        const tableEnd = doc.length;
        const state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(0),
            extensions: [
                markdown({ base: markdownLanguage }),
                livePreviewExtension(null, {
                    resolveWikilink: () => false,
                    navigateWikilink: () => {},
                    getNoteLinkTarget: () => null,
                    openLinkContextMenu: () => {},
                }),
            ],
        });

        const view = new EditorView({ state, parent });

        expect(view.dom.querySelector(".cm-lp-table-widget")).toBeNull();
        expect(forceParsing(view, tableEnd, 100)).toBe(true);
        expect(view.dom.querySelector(".cm-lp-table-widget")).not.toBeNull();

        view.destroy();
        parent.remove();
    });

    it("shows the compact code frame even when the caret is on the fence line", () => {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const state = EditorState.create({
            doc: "```ts\nconst value = 1;\n```",
            selection: EditorSelection.cursor(1),
            extensions: [
                markdown({ base: markdownLanguage }),
                livePreviewExtension(null, {
                    resolveWikilink: () => false,
                    navigateWikilink: () => {},
                    getNoteLinkTarget: () => null,
                    openLinkContextMenu: () => {},
                }),
            ],
        });

        const view = new EditorView({ state, parent });

        const header = view.dom.querySelector(".cm-code-block-header");
        expect(header).not.toBeNull();
        expect(header?.textContent).toContain("TypeScript");
        expect(header?.textContent).not.toContain("Copy");
        const copyButton = header?.querySelector<HTMLButtonElement>(
            '.cm-code-block-copy[aria-label="Copy code block"]',
        );
        expect(copyButton?.title).toBe("Copy");
        expect(copyButton?.querySelector("svg")).not.toBeNull();

        view.destroy();
        parent.remove();
    });

    it("matches the chat treatment for unlabeled code fences", () => {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const view = new EditorView({
            state: createLivePreviewState("```\nplain text\n```"),
            parent,
        });

        expect(view.dom.querySelector(".cm-code-block-lang")).toBeNull();
        expect(
            view.dom.querySelector(".cm-code-block-header-unlabeled"),
        ).not.toBeNull();
        expect(
            view.dom.querySelector(".cm-code-block-line-unlabeled"),
        ).not.toBeNull();

        view.destroy();
        parent.remove();
    });

    it("renders pdf embeds when the file name contains brackets", () => {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const doc =
            "![[/RESEARCH/2026/Papers/2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf]]\nNext line";
        const state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.length),
            extensions: [
                markdown({ base: markdownLanguage }),
                livePreviewExtension("/vault", {
                    resolveWikilink: () => false,
                    navigateWikilink: () => {},
                    getNoteLinkTarget: () => null,
                    openLinkContextMenu: () => {},
                }),
            ],
        });

        const view = new EditorView({ state, parent });

        const embed = view.dom.querySelector(".cm-pdf-embed-chip");
        expect(embed).not.toBeNull();
        expect(view.dom.querySelector(".cm-pdf-embed-name")?.textContent).toBe(
            "2025 - DeepSeek-R1 Reasoning via RL [DeepSeek].pdf",
        );

        view.destroy();
        parent.remove();
    });
});
