import { useEditorStore } from "../../app/store/editorStore";
import type { TabInput } from "../../app/store/editorTabs";
import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    insertVaultEntryTab,
    insertVaultEntryTabAtPaneDropTarget,
} from "../../app/utils/vaultEntries";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import type { FileTreeNoteDragDetail } from "../ai/dragEvents";
import { isPointOverAiComposerDropZone } from "./tabDragAttachments";
import {
    resolvePaneStripDropIndex,
    resolveWorkspaceTabDropIntent,
    type CrossPaneTabDropPreview,
} from "./workspaceTabDropPreview";

const FILE_DROP_SOURCE_PANE_ID = "__file-drop-source__";
const FILE_DROP_PREVIEW_TAB_ID = "__file-drop-preview__";

type WorkspaceFileDropTarget = Extract<
    WorkspaceDropTarget,
    { type: "strip" | "pane-center" | "split" }
>;

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

export function isWorkspaceFileDropTarget(
    target: WorkspaceDropTarget,
): target is WorkspaceFileDropTarget {
    return (
        target.type === "strip" ||
        target.type === "pane-center" ||
        target.type === "split"
    );
}

export function resolveWorkspaceFileDropIntent(
    clientX: number,
    clientY: number,
): { target: WorkspaceDropTarget; preview: CrossPaneTabDropPreview | null } {
    if (isPointOverAiComposerDropZone(clientX, clientY)) {
        return { target: { type: "none" }, preview: null };
    }

    return resolveWorkspaceTabDropIntent({
        sourcePaneId: FILE_DROP_SOURCE_PANE_ID,
        tabId: FILE_DROP_PREVIEW_TAB_ID,
        clientX,
        clientY,
    });
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

export async function openDroppedVaultPathsAtTarget(
    paths: string[],
    target: WorkspaceFileDropTarget,
) {
    const entriesByPath = new Map(
        useVaultStore.getState().entries.map((entry) => [entry.path, entry]),
    );
    let paneId: string | null = target.type === "split" ? null : target.paneId;
    let nextIndex = getInitialInsertIndex(target);

    for (const path of paths) {
        const entry = entriesByPath.get(path);
        if (!entry) {
            continue;
        }

        if (!paneId && target.type === "split") {
            paneId = await insertVaultEntryTabAtPaneDropTarget(
                entry,
                target,
                nextIndex,
            );
            if (paneId) {
                nextIndex += 1;
            }
            continue;
        }

        if (!paneId) {
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

export async function openDroppedTreeItemsAtTarget(
    detail: FileTreeNoteDragDetail,
    target: WorkspaceFileDropTarget,
) {
    let paneId: string | null = target.type === "split" ? null : target.paneId;
    let nextIndex = getInitialInsertIndex(target);

    const insertTab = async (tab: TabInput) => {
        if (!paneId && target.type === "split") {
            paneId = useEditorStore
                .getState()
                .insertExternalTabAtPaneDropTarget(
                    tab,
                    target.paneId,
                    target.direction,
                    nextIndex,
                );
            if (paneId) {
                nextIndex += 1;
            }
            return;
        }

        if (!paneId) {
            return;
        }

        useEditorStore.getState().insertExternalTabInPane(
            tab,
            paneId,
            nextIndex,
        );
        nextIndex += 1;
    };

    for (const note of detail.notes) {
        try {
            const noteDetail = await vaultInvoke<{ content: string }>(
                "read_note",
                {
                    noteId: note.id,
                },
            );
            await insertTab({
                id: crypto.randomUUID(),
                kind: "note",
                noteId: note.id,
                title: note.title,
                content: noteDetail.content,
            });
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

        if (!paneId && target.type === "split") {
            paneId = await insertVaultEntryTabAtPaneDropTarget(
                entry,
                target,
                nextIndex,
            );
            if (paneId) {
                nextIndex += 1;
            }
            continue;
        }

        if (!paneId) {
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

export function getWorkspaceFileDropPaneId(target: WorkspaceDropTarget) {
    return isWorkspaceFileDropTarget(target) ? target.paneId : null;
}

function getInitialInsertIndex(target: WorkspaceFileDropTarget) {
    if (target.type === "strip") {
        return target.index;
    }

    if (target.type === "split") {
        return 0;
    }

    return (
        useEditorStore
            .getState()
            .panes.find((pane) => pane.id === target.paneId)?.tabs.length ?? 0
    );
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
