import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { insertVaultEntryTab } from "../../app/utils/vaultEntries";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import type { FileTreeNoteDragDetail } from "../ai/dragEvents";
import { isPointOverAiComposerDropZone } from "./tabDragAttachments";
import { resolvePaneStripDropIndex } from "./workspaceTabDropPreview";

export interface WorkspacePaneFileDropTarget {
    paneId: string;
    insertIndex: number;
}

export function resolveWorkspacePaneFileDropTarget(
    clientX: number,
    clientY: number,
): WorkspacePaneFileDropTarget | null {
    if (isPointOverAiComposerDropZone(clientX, clientY)) {
        return null;
    }

    const paneNodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-editor-pane-id]"),
    );

    for (const paneNode of paneNodes) {
        const paneId = paneNode.dataset.editorPaneId ?? null;
        if (!paneId) {
            continue;
        }

        const paneRect = paneNode.getBoundingClientRect();
        if (!isPointInsideRect(clientX, clientY, paneRect)) {
            continue;
        }

        const strip = paneNode.querySelector<HTMLElement>(
            `[data-pane-tab-strip="${paneId}"]`,
        );
        if (strip) {
            const stripRect = strip.getBoundingClientRect();
            if (isPointInsideRect(clientX, clientY, stripRect)) {
                return {
                    paneId,
                    insertIndex: resolvePaneStripDropIndex(strip, clientX),
                };
            }
        }

        return {
            paneId,
            insertIndex: countPaneTabs(strip),
        };
    }

    return null;
}

export async function openDroppedVaultPathsInPane(
    paths: string[],
    paneId: string,
    insertIndex: number,
) {
    const entriesByPath = new Map(
        useVaultStore.getState().entries.map((entry) => [entry.path, entry]),
    );
    let nextIndex = insertIndex;

    for (const path of paths) {
        const entry = entriesByPath.get(path);
        if (!entry) {
            continue;
        }

        const inserted = await insertVaultEntryTab(entry, nextIndex, {
            paneId,
        });
        if (inserted) {
            nextIndex += 1;
        }
    }
}

export async function openDroppedTreeItemsInPane(
    detail: FileTreeNoteDragDetail,
    paneId: string,
    insertIndex: number,
) {
    let nextIndex = insertIndex;

    for (const note of detail.notes) {
        try {
            const noteDetail = await vaultInvoke<{ content: string }>(
                "read_note",
                {
                    noteId: note.id,
                },
            );
            useEditorStore.getState().insertExternalTabInPane(
                {
                    id: crypto.randomUUID(),
                    kind: "note",
                    noteId: note.id,
                    title: note.title,
                    content: noteDetail.content,
                },
                paneId,
                nextIndex,
            );
            nextIndex += 1;
        } catch (error) {
            console.error("Failed to open dropped note tab:", error);
        }
    }

    for (const file of detail.files ?? []) {
        const entry = useVaultStore
            .getState()
            .entries.find((item) => item.path === file.filePath);
        if (!entry) {
            continue;
        }

        const inserted = await insertVaultEntryTab(entry, nextIndex, {
            paneId,
        });
        if (inserted) {
            nextIndex += 1;
        }
    }
}

function isPointInsideRect(
    clientX: number,
    clientY: number,
    rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
    return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
    );
}

function countPaneTabs(strip: HTMLElement | null) {
    if (!strip) {
        return 0;
    }

    return strip.querySelectorAll("[data-pane-tab-id]").length;
}
