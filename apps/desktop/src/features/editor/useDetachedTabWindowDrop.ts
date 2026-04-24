import { useCallback, useEffect, useRef } from "react";
import type { WebviewWindow } from "@neverwrite/runtime";
import type { Tab } from "../../app/store/editorStore";
import {
    commitDetachedTabDrop,
    createGhostWindow,
    destroyGhostWindow,
    moveGhostWindow,
    resolveDetachWindowDropTarget,
} from "../../app/detachedWindows";

interface DetachPointerCoords {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
}

interface UseDetachedTabWindowDropOptions {
    vaultPath: string | null;
    windowMode: "main" | "note" | "settings" | "ghost";
    getTabById: (tabId: string) => Tab | null;
    getWorkspaceTabCount: () => number;
    closeTab: (tabId: string, options?: { reason?: "detach" }) => void;
}

/**
 * Shared multi-window detach infrastructure for workspace tabs.
 *
 * Ghost previews and cross-window attach/detach routing belong here so pane
 * headers and any global tab surfaces can share one detach contract.
 */
export function useDetachedTabWindowDrop({
    vaultPath,
    windowMode,
    getTabById,
    getWorkspaceTabCount,
    closeTab,
}: UseDetachedTabWindowDropOptions) {
    const ghostRef = useRef<WebviewWindow | null>(null);
    const ghostCancelledRef = useRef(false);

    const cleanupGhostWindow = useCallback(async () => {
        ghostCancelledRef.current = true;
        if (!ghostRef.current) {
            return;
        }

        await destroyGhostWindow(ghostRef.current);
        ghostRef.current = null;
    }, []);

    const handleDetachStart = useCallback(
        async (tabId: string, coords: DetachPointerCoords) => {
            const tab = getTabById(tabId);
            if (!tab) {
                return;
            }

            ghostCancelledRef.current = false;

            try {
                const ghost = await createGhostWindow(
                    tab.title,
                    coords.screenX,
                    coords.screenY,
                );
                if (ghostCancelledRef.current) {
                    void destroyGhostWindow(ghost);
                    return;
                }

                ghostRef.current = ghost;
            } catch (error) {
                console.error("Failed to create ghost window:", error);
            }
        },
        [getTabById],
    );

    const handleDetachMove = useCallback((coords: DetachPointerCoords) => {
        const ghost = ghostRef.current;
        if (!ghost) {
            return;
        }

        void moveGhostWindow(ghost, coords.screenX, coords.screenY);
    }, []);

    const handleDetachCancel = useCallback(() => {
        void cleanupGhostWindow();
    }, [cleanupGhostWindow]);

    const commitDetachDrop = useCallback(
        async (tabId: string, coords: DetachPointerCoords) => {
            await cleanupGhostWindow();

            const tab = getTabById(tabId);
            if (!tab) {
                return;
            }

            await commitDetachedTabDrop({
                tab,
                screenX: coords.screenX,
                screenY: coords.screenY,
                vaultPath,
                windowMode,
                currentWorkspaceTabCount: getWorkspaceTabCount(),
                closeTab,
            });
        },
        [
            cleanupGhostWindow,
            closeTab,
            getTabById,
            getWorkspaceTabCount,
            vaultPath,
            windowMode,
        ],
    );

    useEffect(() => {
        return () => {
            void cleanupGhostWindow();
        };
    }, [cleanupGhostWindow]);

    return {
        resolveDetachDropTarget: (
            _tabId: string,
            coords: Pick<DetachPointerCoords, "clientX" | "clientY">,
        ) => resolveDetachWindowDropTarget(coords.clientX, coords.clientY),
        handleDetachStart,
        handleDetachMove,
        handleDetachCancel,
        commitDetachDrop,
    };
}
