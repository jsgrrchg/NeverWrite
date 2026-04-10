import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    getCurrentWindowLabel,
    publishWindowTabDropZone,
} from "../../app/detachedWindows";
import {
    selectFocusedPaneId,
    selectLeafPaneIds,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { WorkspaceSplitContainer } from "./WorkspaceSplitContainer";
import {
    CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
    type CrossPaneTabDropPreview,
} from "./workspaceTabDropPreview";

function getAppWindow() {
    return getCurrentWindow();
}

async function getWindowContentScreenOrigin() {
    const appWindow = getAppWindow();
    if (
        typeof appWindow.innerPosition !== "function" ||
        typeof appWindow.scaleFactor !== "function"
    ) {
        return { x: window.screenX, y: window.screenY };
    }

    try {
        const [innerPosition, scaleFactor] = await Promise.all([
            appWindow.innerPosition(),
            appWindow.scaleFactor(),
        ]);
        const logicalPosition =
            typeof innerPosition.toLogical === "function"
                ? innerPosition.toLogical(scaleFactor)
                : {
                      x: innerPosition.x / scaleFactor,
                      y: innerPosition.y / scaleFactor,
                  };

        return {
            x: logicalPosition.x,
            y: logicalPosition.y,
        };
    } catch {
        return { x: window.screenX, y: window.screenY };
    }
}

export function MultiPaneWorkspace() {
    const leafPaneIds = useEditorStore(useShallow(selectLeafPaneIds));
    const layoutTree = useEditorStore((state) => state.layoutTree);
    const focusedPaneId = useEditorStore(selectFocusedPaneId);
    const focusPane = useEditorStore((state) => state.focusPane);
    const resizePaneSplit = useEditorStore((state) => state.resizePaneSplit);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [crossPaneDropPreview, setCrossPaneDropPreview] =
        useState<CrossPaneTabDropPreview | null>(null);
    const visiblePaneCount = Math.max(1, leafPaneIds.length);

    useEffect(() => {
        const handleCrossPaneDropPreview = (event: Event) => {
            const detail = (
                event as CustomEvent<CrossPaneTabDropPreview | null>
            ).detail;
            setCrossPaneDropPreview(detail);
        };

        window.addEventListener(
            CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
            handleCrossPaneDropPreview,
        );

        return () => {
            window.removeEventListener(
                CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
                handleCrossPaneDropPreview,
            );
        };
    }, []);

    useLayoutEffect(() => {
        const label = getCurrentWindowLabel();
        let disposed = false;
        let frame: number | null = null;
        let publishVersion = 0;
        let resizeObserver: ResizeObserver | null = null;
        const cleanupListeners: Array<() => void> = [];

        const schedulePublish = () => {
            if (disposed) {
                return;
            }
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }

            frame = window.requestAnimationFrame(() => {
                frame = null;
                const dropZone = containerRef.current;
                if (!dropZone) {
                    publishWindowTabDropZone(label, null);
                    return;
                }

                const rect = dropZone.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    publishWindowTabDropZone(label, null);
                    return;
                }

                const nextVersion = publishVersion + 1;
                publishVersion = nextVersion;
                const nextRect = {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                };

                void getWindowContentScreenOrigin().then((origin) => {
                    if (disposed || publishVersion !== nextVersion) {
                        return;
                    }

                    const left = origin.x + nextRect.left;
                    const top = origin.y + nextRect.top;
                    publishWindowTabDropZone(label, {
                        left: Math.round(left),
                        top: Math.round(top),
                        right: Math.round(left + nextRect.width),
                        bottom: Math.round(top + nextRect.height),
                        vaultPath: useVaultStore.getState().vaultPath,
                    });
                });
            });
        };

        schedulePublish();
        window.addEventListener("resize", schedulePublish);
        window.addEventListener("focus", schedulePublish);

        const node = containerRef.current;
        if (node && typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => {
                schedulePublish();
            });
            resizeObserver.observe(node);
        }

        const appWindow = getAppWindow();

        void Promise.resolve(appWindow.onMoved(schedulePublish)).then(
            (unlisten) => {
                if (typeof unlisten !== "function") {
                    return;
                }
                if (disposed) {
                    void unlisten();
                    return;
                }
                cleanupListeners.push(unlisten);
            },
        );

        void Promise.resolve(appWindow.onResized(schedulePublish)).then(
            (unlisten) => {
                if (typeof unlisten !== "function") {
                    return;
                }
                if (disposed) {
                    void unlisten();
                    return;
                }
                cleanupListeners.push(unlisten);
            },
        );

        void Promise.resolve(appWindow.onScaleChanged(schedulePublish)).then(
            (unlisten) => {
                if (typeof unlisten !== "function") {
                    return;
                }
                if (disposed) {
                    void unlisten();
                    return;
                }
                cleanupListeners.push(unlisten);
            },
        );

        return () => {
            disposed = true;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }
            resizeObserver?.disconnect();
            window.removeEventListener("resize", schedulePublish);
            window.removeEventListener("focus", schedulePublish);
            cleanupListeners.forEach((unlisten) => {
                void unlisten();
            });
            publishWindowTabDropZone(label, null);
        };
    }, [visiblePaneCount]);

    const handlePaneFocus = useCallback(
        (paneId: string) => {
            focusPane(paneId);
        },
        [focusPane],
    );

    const handleResizeSplit = useCallback(
        (splitId: string, sizes: readonly number[]) => {
            resizePaneSplit(splitId, sizes);
        },
        [resizePaneSplit],
    );

    return (
        <div
            ref={containerRef}
            className="flex h-full min-h-0 min-w-0 overflow-hidden"
        >
            <WorkspaceSplitContainer
                node={layoutTree}
                focusedPaneId={focusedPaneId}
                onPaneFocus={handlePaneFocus}
                onResizeSplit={handleResizeSplit}
                dropPreview={crossPaneDropPreview}
            />
        </div>
    );
}
