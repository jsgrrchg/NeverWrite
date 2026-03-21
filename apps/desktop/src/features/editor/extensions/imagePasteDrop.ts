import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";

const ACCEPTED_MIME_RE =
    /^(image\/(png|jpe?g|gif|svg\+xml|webp|bmp|x-icon|avif)|application\/pdf)$/;

const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/avif": "avif",
    "application/pdf": "pdf",
};

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function buildTimestamp(): string {
    const now = new Date();
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
    ].join("");
}

function buildFileName(file: File): string {
    const ext = MIME_TO_EXT[file.type] ?? "bin";
    const defaultNames = new Set(["image.png", "image", "blob"]);
    if (file.name && !defaultNames.has(file.name)) {
        const base = file.name.replace(/\.[^.]+$/, "");
        return `${base}-${buildTimestamp()}.${ext}`;
    }
    return `paste-${buildTimestamp()}.${ext}`;
}

function extractFiles(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];
    const files: File[] = [];
    for (let i = 0; i < dataTransfer.files.length; i++) {
        const file = dataTransfer.files[i];
        if (ACCEPTED_MIME_RE.test(file.type) && file.size <= MAX_FILE_SIZE) {
            files.push(file);
        }
    }
    return files;
}

async function saveAndInsert(
    file: File,
    view: EditorView,
    insertPos: number,
): Promise<void> {
    const fileName = buildFileName(file);
    const buffer = await file.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));

    await vaultInvoke<{
        path: string;
        relative_path: string;
        file_name: string;
        mime_type: string | null;
    }>("save_vault_binary_file", {
        relativeDir: "assets",
        fileName,
        bytes,
    });

    const markup = `![[/assets/${fileName}]]`;
    view.dispatch({
        changes: { from: insertPos, insert: markup },
        selection: { anchor: insertPos + markup.length },
    });
}

// --- Drag overlay visual feedback ---

let dragDepth = 0;

function showDragOverlay(view: EditorView) {
    view.dom.classList.add("cm-drag-active");
}

function hideDragOverlay(view: EditorView) {
    view.dom.classList.remove("cm-drag-active");
}

function hasAcceptedFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    for (let i = 0; i < dataTransfer.items.length; i++) {
        const item = dataTransfer.items[i];
        if (item.kind === "file" && ACCEPTED_MIME_RE.test(item.type))
            return true;
    }
    return false;
}

// --- Theme ---

const dragOverlayTheme = EditorView.baseTheme({
    "&.cm-drag-active": {
        outline: "2px dashed var(--accent, #3b82f6)",
        outlineOffset: "-2px",
        backgroundColor:
            "color-mix(in srgb, var(--accent, #3b82f6) 6%, transparent)",
    },
});

// --- Extension ---

export function imagePasteDropExtension(): Extension {
    const handlers = EditorView.domEventHandlers({
        paste(event: ClipboardEvent, view: EditorView) {
            const files = extractFiles(event.clipboardData);
            if (files.length === 0) return false;

            event.preventDefault();

            const pos = view.state.selection.main.head;
            for (const file of files) {
                saveAndInsert(file, view, pos).catch((err) =>
                    console.error(
                        "[imagePasteDrop] Failed to save pasted image:",
                        err,
                    ),
                );
            }
            return true;
        },

        drop(event: DragEvent, view: EditorView) {
            const files = extractFiles(event.dataTransfer);
            if (files.length === 0) return false;

            event.preventDefault();
            dragDepth = 0;
            hideDragOverlay(view);

            const dropPos =
                view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
                view.state.selection.main.head;

            for (const file of files) {
                saveAndInsert(file, view, dropPos).catch((err) =>
                    console.error(
                        "[imagePasteDrop] Failed to save dropped image:",
                        err,
                    ),
                );
            }
            return true;
        },

        dragenter(event: DragEvent, view: EditorView) {
            if (!hasAcceptedFiles(event.dataTransfer)) return false;
            dragDepth++;
            if (dragDepth === 1) showDragOverlay(view);
            return false;
        },

        dragleave(event: DragEvent, view: EditorView) {
            if (!hasAcceptedFiles(event.dataTransfer)) return false;
            dragDepth--;
            if (dragDepth <= 0) {
                dragDepth = 0;
                hideDragOverlay(view);
            }
            return false;
        },

        dragover(event: DragEvent) {
            if (!hasAcceptedFiles(event.dataTransfer)) return false;
            event.preventDefault();
            return false;
        },
    });

    return [handlers, dragOverlayTheme];
}
