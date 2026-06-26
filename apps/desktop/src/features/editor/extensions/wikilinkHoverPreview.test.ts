/**
 * @vitest-environment jsdom
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildWikilinkHoverTooltip,
    wikilinkHoverPreviewExtension,
} from "./wikilinkHoverPreview";
import { getWikilinkHoverPreviewExtension } from "../editorExtensions";
import { invalidateNotePreviewCache } from "./notePreviewSource";
import { useVaultStore } from "../../../app/store/vaultStore";

vi.mock("@neverwrite/runtime", () => ({ invoke: vi.fn() }));
import { invoke } from "@neverwrite/runtime";

function createView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
    });
    const view = new EditorView({ state, parent });
    return { parent, view };
}

function seedNote(id: string, title: string) {
    useVaultStore.setState({
        vaultPath: "/vault",
        notes: [
            {
                id,
                path: `/vault/${id}.md`,
                title,
                modified_at: 0,
                created_at: 0,
            },
        ],
    });
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    invalidateNotePreviewCache("Note");
    useVaultStore.setState({ notes: [] });
});

describe("buildWikilinkHoverTooltip", () => {
    it("returns an anchored tooltip when hovering inside a wikilink", () => {
        const { parent, view } = createView("before [[Target]] after");

        // Position inside the [[Target]] token.
        const tooltip = buildWikilinkHoverTooltip(view, 11);
        expect(tooltip).not.toBeNull();
        expect(tooltip?.pos).toBe(7);
        expect(tooltip?.end).toBe(17);

        const mounted = tooltip?.create?.(view);
        expect(
            mounted?.dom.querySelector(".cm-wikilink-hover-title")?.textContent,
        ).toBe("Target");

        view.destroy();
        parent.remove();
    });

    it("uses the target side of a piped wikilink", () => {
        const { parent, view } = createView("[[Target|alias]]");
        const tooltip = buildWikilinkHoverTooltip(view, 4);
        const mounted = tooltip?.create?.(view);
        expect(
            mounted?.dom.querySelector(".cm-wikilink-hover-title")?.textContent,
        ).toBe("Target");

        view.destroy();
        parent.remove();
    });

    it("returns null outside any wikilink", () => {
        const { parent, view } = createView("before [[Target]] after");
        expect(buildWikilinkHoverTooltip(view, 2)).toBeNull();

        view.destroy();
        parent.remove();
    });

    it("renders loading then note content, and serves the second hover from cache", async () => {
        seedNote("Note", "Note");
        vi.mocked(invoke).mockResolvedValue({
            content: "# Note body\nhello world",
        });

        const { parent, view } = createView("see [[Note]] here");

        // First hover: no synchronous content, so a loading placeholder shows
        // while the async read resolves.
        const first = buildWikilinkHoverTooltip(view, 7)?.create?.(view);
        const firstBody = first?.dom.querySelector(".cm-wikilink-hover-body");
        expect(firstBody?.textContent).toBe("Loading…");

        await vi.waitFor(() => {
            expect(firstBody?.querySelector(".cm-note-embed-h1")?.textContent).toBe(
                "Note body",
            );
        });
        expect(firstBody?.textContent).toContain("hello world");
        expect(invoke).toHaveBeenCalledTimes(1);

        // Second hover: content is cached, so it renders synchronously with no
        // additional read.
        const second = buildWikilinkHoverTooltip(view, 7)?.create?.(view);
        const secondBody = second?.dom.querySelector(".cm-wikilink-hover-body");
        expect(secondBody?.querySelector(".cm-note-embed-h1")?.textContent).toBe(
            "Note body",
        );
        expect(invoke).toHaveBeenCalledTimes(1);

        view.destroy();
        parent.remove();
    });

    it("previews a #section from the target heading", async () => {
        seedNote("Note", "Note");
        vi.mocked(invoke).mockResolvedValue({
            content: [
                "# Intro",
                "intro body",
                "## Details",
                "detail body line",
            ].join("\n"),
        });

        const { parent, view } = createView("see [[Note#Details]] now");
        const mounted = buildWikilinkHoverTooltip(view, 8)?.create?.(view);
        const body = mounted?.dom.querySelector(".cm-wikilink-hover-body");
        const titleText = mounted?.dom.querySelector(
            ".cm-wikilink-hover-title",
        )?.textContent;
        expect(titleText).toBe("Note > Details");

        await vi.waitFor(() => {
            expect(body?.textContent).toContain("detail body line");
        });
        // Section preview is scoped: content from before the heading is excluded.
        expect(body?.textContent).not.toContain("intro body");

        view.destroy();
        parent.remove();
    });

    it("shows a create action for an unresolved target", async () => {
        const { parent, view } = createView("see [[Ghost]] now");
        const mounted = buildWikilinkHoverTooltip(view, 8)?.create?.(view);
        const body = mounted?.dom.querySelector(".cm-wikilink-hover-body");

        await vi.waitFor(() => {
            expect(body?.textContent).toBe("No note yet — click to create");
        });
        expect(
            body?.querySelector(".cm-wikilink-hover-action"),
        ).not.toBeNull();

        view.destroy();
        parent.remove();
    });

    it("labels a non-markdown file target by name and type", () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            entries: [
                {
                    id: "diagram.png",
                    path: "/vault/diagram.png",
                    relative_path: "diagram.png",
                    title: "diagram",
                    file_name: "diagram.png",
                    extension: "png",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 0,
                    mime_type: "image/png",
                },
            ],
        });

        const { parent, view } = createView("see [[diagram.png]] now");
        const mounted = buildWikilinkHoverTooltip(view, 8)?.create?.(view);
        expect(
            mounted?.dom.querySelector(".cm-wikilink-hover-title")?.textContent,
        ).toBe("diagram.png");
        expect(
            mounted?.dom.querySelector(".cm-wikilink-hover-meta")?.textContent,
        ).toBe("Image");

        useVaultStore.setState({ entries: [] });
        view.destroy();
        parent.remove();
    });

    it("does not repaint after the tooltip is destroyed", async () => {
        seedNote("Note", "Note");
        let resolveRead: (value: { content: string }) => void = () => {};
        vi.mocked(invoke).mockReturnValue(
            new Promise((resolve) => {
                resolveRead = resolve;
            }),
        );

        const { parent, view } = createView("see [[Note]] here");
        const mounted = buildWikilinkHoverTooltip(view, 7)?.create?.(view);
        const body = mounted?.dom.querySelector(".cm-wikilink-hover-body");
        expect(body?.textContent).toBe("Loading…");

        mounted?.destroy?.();
        resolveRead({ content: "# Note body" });
        await Promise.resolve();
        await Promise.resolve();

        // Still the placeholder — the resolved load was ignored post-destroy.
        expect(body?.querySelector(".cm-note-embed-h1")).toBeNull();

        view.destroy();
        parent.remove();
    });
});

describe("getWikilinkHoverPreviewExtension", () => {
    it("registers the hover extension when enabled", () => {
        const extension = getWikilinkHoverPreviewExtension(true, 300);
        expect(Array.isArray(extension)).toBe(true);
        expect(extension).toHaveLength(2);
    });

    it("registers nothing when disabled", () => {
        expect(getWikilinkHoverPreviewExtension(false, 300)).toEqual([]);
    });

    it("builds the extension with a configurable delay", () => {
        expect(wikilinkHoverPreviewExtension(750)).toHaveLength(2);
    });
});
