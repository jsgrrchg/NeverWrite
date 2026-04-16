import {
    Fragment,
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import type { WorkspaceLayoutNode } from "../../app/store/workspaceLayoutTree";
import { EditorPaneBar } from "./EditorPaneBar";
import { EditorPaneContent } from "./EditorPaneContent";

const RESIZER_HITBOX_SIZE = 10;
const RESIZER_VISIBLE_SIZE = 1;
const MIN_PANE_WIDTH = 180;
const MIN_PANE_HEIGHT = 140;

interface ResizeSession {
    pointerId: number;
    dividerIndex: number;
    direction: "row" | "column";
    startPointerOffset: number;
    startSizes: number[];
    containerMainAxisSize: number;
    minSizes: number[];
}

interface NodeConstraints {
    minWidth: number;
    minHeight: number;
}

interface WorkspaceSplitContainerProps {
    node: WorkspaceLayoutNode;
    focusedPaneId: string | null;
    externalFileDropPaneId: string | null;
    onPaneFocus: (paneId: string) => void;
    onResizeSplit: (splitId: string, sizes: readonly number[]) => void;
}

function getNodeConstraints(node: WorkspaceLayoutNode): NodeConstraints {
    if (node.type === "pane") {
        return {
            minWidth: MIN_PANE_WIDTH,
            minHeight: MIN_PANE_HEIGHT,
        };
    }

    const childConstraints = node.children.map((child) =>
        getNodeConstraints(child),
    );

    if (node.direction === "row") {
        return {
            minWidth: childConstraints.reduce(
                (sum, child) => sum + child.minWidth,
                0,
            ),
            minHeight: childConstraints.reduce(
                (max, child) => Math.max(max, child.minHeight),
                MIN_PANE_HEIGHT,
            ),
        };
    }

    return {
        minWidth: childConstraints.reduce(
            (max, child) => Math.max(max, child.minWidth),
            MIN_PANE_WIDTH,
        ),
        minHeight: childConstraints.reduce(
            (sum, child) => sum + child.minHeight,
            0,
        ),
    };
}

function clampSplitResize(
    pairSize: number,
    proposedLeadingSize: number,
    leadingMinSize: number,
    trailingMinSize: number,
) {
    const maxLeadingSize = Math.max(leadingMinSize, pairSize - trailingMinSize);
    return Math.max(
        leadingMinSize,
        Math.min(maxLeadingSize, proposedLeadingSize),
    );
}

const WorkspacePane = memo(function WorkspacePane({
    paneId,
    isFocused,
    isExternalFileDropActive,
    onPaneFocus,
}: {
    paneId: string;
    isFocused: boolean;
    isExternalFileDropActive: boolean;
    onPaneFocus: (paneId: string) => void;
}) {
    return (
        <div
            className="relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
            style={{
                minWidth: MIN_PANE_WIDTH,
                minHeight: MIN_PANE_HEIGHT,
                border: "1px solid color-mix(in srgb, var(--border) 76%, transparent)",
                borderRadius: 0,
                background: "var(--bg-primary)",
                boxShadow: isExternalFileDropActive
                    ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 52%, transparent)"
                    : isFocused
                      ? "inset 0 1px 0 color-mix(in srgb, var(--accent) 16%, transparent)"
                      : "none",
            }}
            onPointerDownCapture={() => onPaneFocus(paneId)}
            onFocusCapture={() => onPaneFocus(paneId)}
            data-editor-pane-id={paneId}
            data-editor-pane-focused={isFocused || undefined}
            data-editor-pane-file-drop-active={
                isExternalFileDropActive || undefined
            }
        >
            {isExternalFileDropActive ? (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-20"
                    style={{
                        background:
                            "color-mix(in srgb, var(--accent) 7%, transparent)",
                        boxShadow:
                            "inset 0 0 0 1px color-mix(in srgb, var(--accent) 38%, transparent)",
                    }}
                />
            ) : null}
            <EditorPaneBar paneId={paneId} isFocused={isFocused} />
            <EditorPaneContent
                paneId={paneId}
                emptyStateMessage="This pane is empty. Open a note here or close the pane from its menu."
            />
        </div>
    );
});

export function WorkspaceSplitContainer({
    node,
    focusedPaneId,
    externalFileDropPaneId,
    onPaneFocus,
    onResizeSplit,
}: WorkspaceSplitContainerProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const resizeSessionRef = useRef<ResizeSession | null>(null);
    const [isResizing, setIsResizing] = useState(false);

    const childConstraints = useMemo(
        () =>
            node.type === "split"
                ? node.children.map((child) => getNodeConstraints(child))
                : [],
        [node],
    );

    const stopResize = useCallback((pointerId?: number) => {
        const session = resizeSessionRef.current;
        if (!session) {
            return;
        }
        if (pointerId !== undefined && session.pointerId !== pointerId) {
            return;
        }

        resizeSessionRef.current = null;
        document.body.classList.remove("resizing-editor-pane");
        setIsResizing(false);
    }, []);

    useEffect(() => {
        if (!isResizing) {
            return;
        }

        const handlePointerMove = (event: PointerEvent) => {
            const session = resizeSessionRef.current;
            if (!session) {
                return;
            }

            const leadingIndex = session.dividerIndex;
            const trailingIndex = leadingIndex + 1;
            const startLeadingSize =
                session.startSizes[leadingIndex] *
                session.containerMainAxisSize;
            const startTrailingSize =
                session.startSizes[trailingIndex] *
                session.containerMainAxisSize;
            const pairSize = startLeadingSize + startTrailingSize;
            const pointerOffset =
                session.direction === "row" ? event.clientX : event.clientY;
            const delta = pointerOffset - session.startPointerOffset;
            const nextLeadingSize = clampSplitResize(
                pairSize,
                startLeadingSize + delta,
                session.minSizes[leadingIndex] ?? 0,
                session.minSizes[trailingIndex] ?? 0,
            );
            const nextTrailingSize = pairSize - nextLeadingSize;
            const nextSizes = [...session.startSizes];
            nextSizes[leadingIndex] =
                nextLeadingSize / session.containerMainAxisSize;
            nextSizes[trailingIndex] =
                nextTrailingSize / session.containerMainAxisSize;
            onResizeSplit(node.id, nextSizes);
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
    }, [isResizing, node.id, onResizeSplit, stopResize]);

    const handleDividerPointerDown = useCallback(
        (dividerIndex: number, event: ReactPointerEvent<HTMLDivElement>) => {
            const isPrimaryMouseButton =
                event.pointerType !== "mouse" || event.button === 0;

            if (node.type !== "split" || !isPrimaryMouseButton) {
                return;
            }

            const container = containerRef.current;
            if (!container) {
                return;
            }

            const rect = container.getBoundingClientRect();
            const containerMainAxisSize =
                node.direction === "row" ? rect.width : rect.height;
            if (containerMainAxisSize <= 0) {
                return;
            }

            resizeSessionRef.current = {
                pointerId: event.pointerId,
                dividerIndex,
                direction: node.direction,
                startPointerOffset:
                    node.direction === "row" ? event.clientX : event.clientY,
                startSizes: node.sizes,
                containerMainAxisSize,
                minSizes: childConstraints.map((constraints) =>
                    node.direction === "row"
                        ? constraints.minWidth
                        : constraints.minHeight,
                ),
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("resizing-editor-pane");
            setIsResizing(true);
            event.preventDefault();
        },
        [childConstraints, node],
    );

    if (node.type === "pane") {
        return (
            <WorkspacePane
                paneId={node.paneId}
                isFocused={node.paneId === focusedPaneId}
                isExternalFileDropActive={
                    node.paneId === externalFileDropPaneId
                }
                onPaneFocus={onPaneFocus}
            />
        );
    }

    return (
        <div
            ref={containerRef}
            className={`flex h-full min-h-0 min-w-0 w-full flex-1 overflow-hidden ${
                node.direction === "row" ? "flex-row" : "flex-col"
            }`}
            data-workspace-split-id={node.id}
            data-workspace-split-direction={node.direction}
        >
            {node.children.map((child, index) => {
                const constraints = childConstraints[index] ?? {
                    minWidth: MIN_PANE_WIDTH,
                    minHeight: MIN_PANE_HEIGHT,
                };
                const orientation =
                    node.direction === "row" ? "vertical" : "horizontal";
                const cursor =
                    node.direction === "row" ? "col-resize" : "row-resize";

                return (
                    <Fragment key={child.id}>
                        <div
                            className="flex min-h-0 min-w-0 overflow-hidden"
                            style={{
                                flexBasis: 0,
                                flexGrow: node.sizes[index] ?? 1,
                                minWidth: constraints.minWidth,
                                minHeight: constraints.minHeight,
                            }}
                        >
                            <WorkspaceSplitContainer
                                node={child}
                                focusedPaneId={focusedPaneId}
                                externalFileDropPaneId={externalFileDropPaneId}
                                onPaneFocus={onPaneFocus}
                                onResizeSplit={onResizeSplit}
                            />
                        </div>
                        {index < node.children.length - 1 ? (
                            <div
                                className="relative shrink-0"
                                style={{
                                    width:
                                        node.direction === "row"
                                            ? RESIZER_VISIBLE_SIZE
                                            : "100%",
                                    height:
                                        node.direction === "column"
                                            ? RESIZER_VISIBLE_SIZE
                                            : "100%",
                                    background:
                                        "color-mix(in srgb, var(--border) 40%, transparent)",
                                    zIndex: 10,
                                }}
                            >
                                {/* Drag hitbox — overlaps adjacent panes for a comfortable grab area */}
                                <div
                                    role="separator"
                                    aria-orientation={orientation}
                                    aria-label={`Resize split ${node.id} sections ${index + 1} and ${index + 2}`}
                                    className="group/resizer absolute"
                                    style={{
                                        left:
                                            node.direction === "row"
                                                ? -(
                                                      RESIZER_HITBOX_SIZE -
                                                      RESIZER_VISIBLE_SIZE
                                                  ) / 2
                                                : 0,
                                        top:
                                            node.direction === "column"
                                                ? -(
                                                      RESIZER_HITBOX_SIZE -
                                                      RESIZER_VISIBLE_SIZE
                                                  ) / 2
                                                : 0,
                                        width:
                                            node.direction === "row"
                                                ? RESIZER_HITBOX_SIZE
                                                : "100%",
                                        height:
                                            node.direction === "column"
                                                ? RESIZER_HITBOX_SIZE
                                                : "100%",
                                        cursor,
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
                                    {/* Hover indicator */}
                                    <div
                                        aria-hidden="true"
                                        className="absolute rounded-full opacity-0 transition-opacity duration-150 group-hover/resizer:opacity-100"
                                        style={{
                                            left:
                                                node.direction === "row"
                                                    ? "50%"
                                                    : 0,
                                            top:
                                                node.direction === "column"
                                                    ? "50%"
                                                    : 0,
                                            bottom:
                                                node.direction === "row"
                                                    ? 0
                                                    : "auto",
                                            right:
                                                node.direction === "column"
                                                    ? 0
                                                    : "auto",
                                            width:
                                                node.direction === "row"
                                                    ? 3
                                                    : "100%",
                                            height:
                                                node.direction === "column"
                                                    ? 3
                                                    : "100%",
                                            transform:
                                                node.direction === "row"
                                                    ? "translateX(-50%)"
                                                    : "translateY(-50%)",
                                            background:
                                                "color-mix(in srgb, var(--accent) 40%, var(--border))",
                                        }}
                                    />
                                </div>
                            </div>
                        ) : null}
                    </Fragment>
                );
            })}
        </div>
    );
}
