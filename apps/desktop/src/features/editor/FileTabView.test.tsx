import { act, fireEvent, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import userEvent from "@testing-library/user-event";
import { openPath } from "@tauri-apps/plugin-opener";
import { describe, expect, it, vi } from "vitest";
import { FileTabView } from "./FileTabView";
import {
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
} from "../../test/test-utils";

describe("FileTabView", () => {
    it("renders image files with native-first controls", async () => {
        const user = userEvent.setup();

        setEditorTabs([
            {
                id: "image-tab",
                kind: "file",
                relativePath: "assets/photo.webp",
                title: "photo.webp",
                path: "/vault/assets/photo.webp",
                mimeType: "image/webp",
                viewer: "image",
                content: "",
            },
        ]);

        renderComponent(<FileTabView />);

        expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Actual Size" }),
        ).toBeInTheDocument();
        expect(screen.getByAltText("photo.webp")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open Externally" }));
        expect(vi.mocked(openPath)).toHaveBeenCalledWith("/vault/assets/photo.webp");
    });

    it("supports Command + wheel zoom from fit mode", () => {
        setEditorTabs([
            {
                id: "image-tab",
                kind: "file",
                relativePath: "assets/photo.webp",
                title: "photo.webp",
                path: "/vault/assets/photo.webp",
                mimeType: "image/webp",
                viewer: "image",
                content: "",
            },
        ]);

        const { container } = renderComponent(<FileTabView />);
        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;
        const image = screen.getByAltText("photo.webp") as HTMLImageElement;

        expect(scrollSurface?.style.touchAction).toBe("pan-x pan-y pinch-zoom");
        expect(image.style.touchAction).toBe("pan-x pan-y pinch-zoom");

        fireEvent.keyDown(window, { key: "Meta" });
        fireEvent.wheel(scrollSurface!, { deltaY: -10 });
        fireEvent.keyUp(window, { key: "Meta" });

        expect(screen.getByText("102.5%")).toBeInTheDocument();
    });

    it("renders text files in an editable editor without preview", async () => {
        vi.useFakeTimers();
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: "name = \"VaultAI\"",
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();
        expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
        expect(editorElement).toHaveAttribute(
            "data-live-preview",
            "false",
        );
        expect(screen.getByText("name = \"VaultAI\"")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Fit" })).not.toBeInTheDocument();
        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();
        expect(view!.state.facet(EditorState.readOnly)).toBe(false);

        mockInvoke().mockResolvedValue({
            relative_path: "src/config.toml",
            file_name: "config.toml",
            content: "name = \"VaultAI\"\nversion = \"1.0.0\"",
        });

        act(() => {
            view!.dispatch({
                changes: {
                    from: view!.state.doc.length,
                    insert: "\nversion = \"1.0.0\"",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(mockInvoke()).toHaveBeenCalledWith("save_vault_file", {
            vaultPath: "/vault",
            relativePath: "src/config.toml",
            content: "name = \"VaultAI\"\nversion = \"1.0.0\"",
        });
    });
});
