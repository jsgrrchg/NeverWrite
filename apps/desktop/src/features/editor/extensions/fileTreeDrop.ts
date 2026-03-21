import { type Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import {
    FILE_TREE_NOTE_DRAG_EVENT,
    type FileTreeNoteDragDetail,
} from "../../ai/dragEvents";
import { useVaultStore } from "../../../app/store/vaultStore";

/**
 * CM6 extension that listens for file-tree drag events and inserts
 * a wikilink embed when a file (PDF, image, etc.) is dropped onto the editor.
 *
 * Files dragged from the file tree are NOT copied to assets —
 * the wikilink points to their existing vault-relative path.
 */
export function fileTreeDropExtension(): Extension {
    return ViewPlugin.define((view) => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<FileTreeNoteDragDetail>).detail;
            if (detail.phase !== "end") return;
            if (!detail.files || detail.files.length === 0) return;

            const editorRect = view.dom.getBoundingClientRect();
            if (
                detail.x < editorRect.left ||
                detail.x > editorRect.right ||
                detail.y < editorRect.top ||
                detail.y > editorRect.bottom
            ) {
                return;
            }

            const pos =
                view.posAtCoords({ x: detail.x, y: detail.y }) ??
                view.state.selection.main.head;

            const vaultPath = useVaultStore.getState().vaultPath;
            let markup = "";

            for (const file of detail.files) {
                let relativePath = file.filePath;
                if (vaultPath && relativePath.startsWith(vaultPath)) {
                    relativePath = relativePath
                        .slice(vaultPath.length)
                        .replace(/^\//, "");
                }
                markup += `![[/${relativePath}]]\n`;
            }

            if (markup) {
                view.dispatch({
                    changes: { from: pos, insert: markup },
                    selection: { anchor: pos + markup.length },
                });
                view.focus();
            }
        };

        window.addEventListener(FILE_TREE_NOTE_DRAG_EVENT, handler);
        return {
            destroy() {
                window.removeEventListener(FILE_TREE_NOTE_DRAG_EVENT, handler);
            },
        };
    });
}
