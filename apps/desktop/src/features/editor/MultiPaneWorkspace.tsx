import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    getCurrentWindowLabel,
    publishWindowTabDropZone,
} from "../../app/detachedWindows";
import { useEditorStore } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { EditorPaneBar } from "./EditorPaneBar";
import { EditorPaneContent } from "./EditorPaneContent";

const RESIZER_HITBOX_WIDTH = 10;
const RESIZER_VISIBLE_WIDTH = 1;
const MIN_PANE_WIDTH = 280;
const MIN_PANE_WIDTH_FALLBACK = 180;

interface ResizeSession {
    pointerId: number;
    dividerIndex: number;
    startX: number;
    startSizes: number[];
    containerWidth: number;
}

function getEffectiveMinPaneWidth(containerWidth: number, paneCount: number) {
    const evenWidth = Math.floor(containerWidth / Math.max(1, paneCount));
    return Math.max(
        MIN_PANE_WIDTH_FALLBACK,
        Math.min(
            MIN_PANE_WIDTH,
            Math.max(MIN_PANE_WIDTH_FALLBACK, evenWidth - 12),
        ),
    );
}

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
    const allPanes = useEditorStore((state) => state.panes);
    const focusedPaneId = useEditorStore((state) => state.focusedPaneId);
    const focusPane = useEditorStore((state) => state.focusPane);
    const editorPaneSizes = useLayoutStore((state) => state.editorPaneSizes);
    const ensureEditorPaneSizeCount = useLayoutStore(
        (state) => state.ensureEditorPaneSizeCount,
    );
    const setEditorPaneSizes = useLayoutStore(
        (state) => state.setEditorPaneSizes,
    );
    const containerRef = useRef<HTMLDivElement | null>(null);
    const resizeSessionRef = useRef<ResizeSession | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [isResizing, setIsResizing] = useState(false);
    const panes = useMemo(() => allPanes.slice(0, 3), [allPanes]);
    const paneCount = Math.max(1, panes.length);

    useEffect(() => {
        ensureEditorPaneSizeCount(paneCount);
    }, [ensureEditorPaneSizeCount, paneCount]);

    useEffect(() => {
        const node = containerRef.current;
        if (!node) return;

        const syncWidth = () => {
            setContainerWidth(node.getBoundingClientRect().width);
        };

        syncWidth();
        const observer = new ResizeObserver(() => syncWidth());
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        const label = getCurrentWindowLabel();
        let disposed = false;
        let frame: number | null = null;
        let publishVersion = 0;
        let resizeObserver: ResizeObserver | null = null;
        const cleanupListeners: Array<() => void> = [];

        const schedulePublish = () => {
            if (disposed) return;
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
                    if (disposed || publishVersion !== nextVersion) return;

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

        void Promise.resolve(
            appWindow.onMoved(() => {
                schedulePublish();
            }),
        ).then((unlisten) => {
            if (typeof unlisten !== "function") return;
            if (disposed) {
                void unlisten();
                return;
            }
            cleanupListeners.push(unlisten);
        });

        void Promise.resolve(
            appWindow.onResized(() => {
                schedulePublish();
            }),
        ).then((unlisten) => {
            if (typeof unlisten !== "function") return;
            if (disposed) {
                void unlisten();
                return;
            }
            cleanupListeners.push(unlisten);
        });

        void Promise.resolve(
            appWindow.onScaleChanged(() => {
                schedulePublish();
            }),
        ).then((unlisten) => {
            if (typeof unlisten !== "function") return;
            if (disposed) {
                void unlisten();
                return;
            }
            cleanupListeners.push(unlisten);
        });

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
    }, [paneCount]);

    const paneSizes = useMemo(() => {
        if (editorPaneSizes.length === paneCount) {
            return editorPaneSizes;
        }
        return Array.from({ length: paneCount }, () => 1 / paneCount);
    }, [editorPaneSizes, paneCount]);

    const handlePaneFocus = useCallback(
        (paneId: string) => {
            focusPane(paneId);
        },
        [focusPane],
    );

    const stopResize = useCallback((pointerId?: number) => {
        const session = resizeSessionRef.current;
        if (!session) return;
        if (pointerId !== undefined && session.pointerId !== pointerId) {
            return;
        }
        resizeSessionRef.current = null;
        document.body.classList.remove("resizing-editor-pane");
        setIsResizing(false);
    }, []);

    useEffect(() => {
        if (!isResizing) return;

        const handlePointerMove = (event: PointerEvent) => {
            const session = resizeSessionRef.current;
            if (!session) {
                return;
            }

            const effectiveMinWidth = getEffectiveMinPaneWidth(
                session.containerWidth,
                paneCount,
            );
            const leftIndex = session.dividerIndex;
            const rightIndex = leftIndex + 1;
            const startLeftPx =
                session.startSizes[leftIndex] * session.containerWidth;
            const startRightPx =
                session.startSizes[rightIndex] * session.containerWidth;
            const pairWidth = startLeftPx + startRightPx;
            const deltaPx = event.clientX - session.startX;
            const nextLeftPx = Math.max(
                effectiveMinWidth,
                Math.min(pairWidth - effectiveMinWidth, startLeftPx + deltaPx),
            );
            const nextRightPx = pairWidth - nextLeftPx;
            const nextSizes = [...session.startSizes];
            nextSizes[leftIndex] = nextLeftPx / session.containerWidth;
            nextSizes[rightIndex] = nextRightPx / session.containerWidth;
            setEditorPaneSizes(paneCount, nextSizes);
        };
        const handlePointerUp = () => stopResize();

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        window.addEventListener("blur", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            window.removeEventListener("blur", handlePointerUp);
        };
    }, [isResizing, paneCount, setEditorPaneSizes, stopResize]);

    const handleDividerPointerDown = useCallback(
        (dividerIndex: number, event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            const node = containerRef.current;
            if (!node) return;
            resizeSessionRef.current = {
                pointerId: event.pointerId,
                dividerIndex,
                startX: event.clientX,
                startSizes: paneSizes,
                containerWidth: node.getBoundingClientRect().width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("resizing-editor-pane");
            setIsResizing(true);
            event.preventDefault();
        },
        [paneSizes],
    );

    const effectiveMinWidth =
        containerWidth > 0
            ? getEffectiveMinPaneWidth(containerWidth, paneCount)
            : MIN_PANE_WIDTH_FALLBACK;

    return (
        <div
            ref={containerRef}
            className="flex h-full min-h-0 min-w-0 overflow-hidden"
        >
            {panes.map((pane, index) => {
                const isFocused = pane.id === focusedPaneId;
                return (
                    <Fragment key={pane.id}>
                        <div
                            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
                            style={{
                                flexBasis: 0,
                                flexGrow: paneSizes[index] ?? 1,
                                minWidth: effectiveMinWidth,
                                border: isFocused
                                    ? "1px solid color-mix(in srgb, var(--accent) 26%, var(--border))"
                                    : "1px solid transparent",
                                borderRadius: 14,
                                background: "var(--bg-primary)",
                                boxShadow: isFocused
                                    ? "0 14px 32px rgba(15, 23, 42, 0.08)"
                                    : "none",
                            }}
                            onPointerDownCapture={() =>
                                handlePaneFocus(pane.id)
                            }
                            onFocusCapture={() => handlePaneFocus(pane.id)}
                            data-editor-pane-id={pane.id}
                            data-editor-pane-focused={isFocused || undefined}
                        >
                            <EditorPaneBar
                                paneId={pane.id}
                                isFocused={isFocused}
                            />
                            <EditorPaneContent
                                paneId={pane.id}
                                emptyStateMessage="This pane is empty. Open a note here or close the pane from its menu."
                            />
                        </div>
                        {index < panes.length - 1 && (
                            <div
                                role="separator"
                                aria-orientation="vertical"
                                aria-label={`Resize panes ${index + 1} and ${index + 2}`}
                                className="relative shrink-0"
                                style={{
                                    width: RESIZER_HITBOX_WIDTH,
                                    cursor: "col-resize",
                                }}
                                onPointerDown={(event) =>
                                    handleDividerPointerDown(index, event)
                                }
                                onPointerUp={(event) =>
                                    stopResize(event.pointerId)
                                }
                                onPointerCancel={(event) =>
                                    stopResize(event.pointerId)
                                }
                            >
                                <div
                                    aria-hidden="true"
                                    className="absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-full"
                                    style={{
                                        width: RESIZER_VISIBLE_WIDTH,
                                        background:
                                            "color-mix(in srgb, var(--border) 90%, transparent)",
                                    }}
                                />
                            </div>
                        )}
                    </Fragment>
                );
            })}
        </div>
    );
}
