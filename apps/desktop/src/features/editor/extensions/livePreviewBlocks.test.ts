/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { resolvePreviewAssetPath } from "./livePreviewBlocks";
import { livePreviewExtension } from "./livePreview";

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
    it("shows the code block header even when the caret is on the fence line", () => {
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
        expect(header?.textContent).toContain("ts");
        expect(header?.textContent).toContain("Copy");

        view.destroy();
        parent.remove();
    });
});
