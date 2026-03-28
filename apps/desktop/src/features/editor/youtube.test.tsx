import { act, fireEvent, screen } from "@testing-library/react";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushPromises, renderComponent } from "../../test/test-utils";
import { livePreviewExtension } from "./extensions/livePreview";
import { YouTubeModalHost } from "./YouTubeModalHost";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "./youtube";

describe("youtube URL parsing", () => {
    it.each([
        ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
        [
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
            "dQw4w9WgXcQ",
        ],
        [
            "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
            "dQw4w9WgXcQ",
        ],
    ])("extracts the video id from %s", (url, expectedId) => {
        expect(extractYouTubeVideoId(url)).toBe(expectedId);
    });

    it("builds an embed URL from a music.youtube.com watch link", () => {
        expect(
            getYouTubeEmbedUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
        ).toBe(
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&modestbranding=1&playsinline=1",
        );
    });
});

describe("youtube live preview integration", () => {
    const editorViews: EditorView[] = [];

    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    title: "Music video",
                    thumbnail_url:
                        "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
                }),
            }),
        );
    });

    afterEach(() => {
        for (const view of editorViews.splice(0)) {
            view.destroy();
        }
        vi.unstubAllGlobals();
    });

    function renderLivePreview(doc: string) {
        const parent = document.createElement("div");
        document.body.appendChild(parent);

        const state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.length),
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
        editorViews.push(view);
        return view;
    }

    it("opens the modal with an embedded player when clicking a YouTube card", async () => {
        renderComponent(<YouTubeModalHost />);
        const view = renderLivePreview(
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
        );

        await flushPromises();

        const youtubeCard = view.dom.querySelector(
            ".cm-youtube-link",
        ) as HTMLElement | null;
        expect(youtubeCard).not.toBeNull();

        await act(async () => {
            fireEvent.click(youtubeCard!);
            await flushPromises();
        });

        const iframe = screen.getByTitle("Music video");
        expect(iframe).toBeInTheDocument();
        expect(iframe).toHaveAttribute(
            "src",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&modestbranding=1&playsinline=1",
        );
        expect(fetch).toHaveBeenCalled();
    });
});
