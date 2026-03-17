import { useEffect, useMemo, useRef, useState } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { getTabStripScrollTarget } from "../editor/tabStrip";
import type { TerminalSessionSnapshot } from "./terminal/terminalTypes";

function getStatusColor(status: TerminalSessionSnapshot["status"]) {
    switch (status) {
        case "running":
        case "starting":
            return "var(--accent)";
        case "error":
            return "#ef4444";
        default:
            return "var(--text-secondary)";
    }
}

export interface DeveloperPanelTabItem {
    id: string;
    title: string;
    status: TerminalSessionSnapshot["status"];
    hasCustomTitle: boolean;
    isActive: boolean;
}

function IconButton({
    title,
    onClick,
    disabled,
    children,
}: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            onClick={onClick}
            disabled={disabled}
            className="flex h-7 w-7 items-center justify-center border"
            style={{
                borderRadius: 0,
                borderColor: "var(--border)",
                backgroundColor: "var(--bg-secondary)",
                color: disabled
                    ? "color-mix(in srgb, var(--text-secondary) 50%, transparent)"
                    : "var(--text-secondary)",
                cursor: disabled ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => {
                if (!disabled)
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--accent) 10%, var(--bg-primary))";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "var(--bg-secondary)";
            }}
        >
            {children}
        </button>
    );
}

export function DeveloperPanelHeader({
    tabs,
    activeTabId,
    canClear,
    onClear,
    onNewTab,
    onSelectTab,
    onRenameTab,
    onDuplicateTab,
    onResetTabTitle,
    onReorderTabs,
    onCloseOthers,
    onCloseTab,
    onRestart,
    onRestartTab,
    onHide,
}: {
    tabs: DeveloperPanelTabItem[];
    activeTabId: string | null;
    canClear: boolean;
    onClear: () => void;
    onNewTab: () => void;
    onSelectTab: (tabId: string) => void;
    onRenameTab: (tabId: string, title: string | null) => void;
    onDuplicateTab: (tabId: string) => void;
    onResetTabTitle: (tabId: string) => void;
    onReorderTabs: (fromIndex: number, toIndex: number) => void;
    onCloseOthers: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
    onRestart: () => void;
    onRestartTab: (tabId: string) => void;
    onHide: () => void;
}) {
    const stripRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [editingTabId, setEditingTabId] = useState<string | null>(null);
    const [draftTitle, setDraftTitle] = useState("");
    const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
    const lastReorderTargetRef = useRef<string | null>(null);

    const tabIndexById = useMemo(
        () => new Map(tabs.map((tab, index) => [tab.id, index])),
        [tabs],
    );

    useEffect(() => {
        if (!activeTabId) return;
        const strip = stripRef.current;
        const node = tabRefs.current[activeTabId];
        if (!strip || !node) return;

        const target = getTabStripScrollTarget({
            stripLeft: strip.scrollLeft,
            stripWidth: strip.clientWidth,
            scrollWidth: strip.scrollWidth,
            nodeLeft: node.offsetLeft,
            nodeWidth: node.offsetWidth,
        });
        if (target === null) return;

        if (typeof strip.scrollTo === "function") {
            strip.scrollTo({
                left: target,
                behavior: "smooth",
            });
            return;
        }

        strip.scrollLeft = target;
    }, [activeTabId, tabs]);

    const beginRename = (tabId: string) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) return;
        setEditingTabId(tabId);
        setDraftTitle(tab.title);
        setContextMenu(null);
    };

    const commitRename = () => {
        if (!editingTabId) return;
        onRenameTab(editingTabId, draftTitle);
        setEditingTabId(null);
        setDraftTitle("");
    };

    const cancelRename = () => {
        setEditingTabId(null);
        setDraftTitle("");
    };

    return (
        <div
            className="flex h-8.75 items-stretch gap-2 border-b px-2"
            style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--bg-secondary)",
            }}
        >
            <div
                ref={stripRef}
                role="tablist"
                aria-label="Integrated terminal tabs"
                className="scrollbar-hidden flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
            >
                {tabs.map((tab) => {
                    const isEditing = editingTabId === tab.id;
                    return (
                        <div
                            key={tab.id}
                            ref={(node) => {
                                tabRefs.current[tab.id] = node;
                            }}
                            draggable={!isEditing}
                            className="group flex min-w-0 shrink-0 items-stretch border-r"
                            style={{
                                borderColor:
                                    "color-mix(in srgb, var(--border) 88%, transparent)",
                            }}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    payload: { tabId: tab.id },
                                });
                            }}
                            onDragStart={(event) => {
                                setDraggedTabId(tab.id);
                                lastReorderTargetRef.current = null;
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(
                                    "text/plain",
                                    tab.id,
                                );
                            }}
                            onDragOver={(event) => {
                                event.preventDefault();
                                if (!draggedTabId || draggedTabId === tab.id) {
                                    return;
                                }
                                if (lastReorderTargetRef.current === tab.id) {
                                    return;
                                }

                                const fromIndex =
                                    tabIndexById.get(draggedTabId);
                                const toIndex = tabIndexById.get(tab.id);
                                if (
                                    fromIndex === undefined ||
                                    toIndex === undefined ||
                                    fromIndex === toIndex
                                ) {
                                    return;
                                }

                                lastReorderTargetRef.current = tab.id;
                                onReorderTabs(fromIndex, toIndex);
                            }}
                            onDragEnd={() => {
                                setDraggedTabId(null);
                                lastReorderTargetRef.current = null;
                            }}
                        >
                            <button
                                role="tab"
                                type="button"
                                aria-selected={tab.id === activeTabId}
                                onClick={() => onSelectTab(tab.id)}
                                onDoubleClick={() => beginRename(tab.id)}
                                onMouseDown={(event) => {
                                    if (event.button === 1) {
                                        event.preventDefault();
                                        onCloseTab(tab.id);
                                    }
                                }}
                                className="flex min-w-0 items-center gap-2 px-3 text-left text-xs"
                                style={{
                                    border: "none",
                                    borderRadius: 0,
                                    backgroundColor: tab.isActive
                                        ? "var(--bg-primary)"
                                        : "var(--bg-secondary)",
                                    color: tab.isActive
                                        ? "var(--text-primary)"
                                        : "var(--text-secondary)",
                                    boxShadow: tab.isActive
                                        ? "inset 0 -2px 0 var(--accent)"
                                        : "none",
                                    fontFamily:
                                        '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
                                    width: 168,
                                }}
                                title={tab.title}
                            >
                                <span
                                    className="inline-block h-2 w-2 shrink-0"
                                    style={{
                                        backgroundColor: getStatusColor(
                                            tab.status,
                                        ),
                                        borderRadius: 0,
                                    }}
                                />
                                {isEditing ? (
                                    <input
                                        autoFocus
                                        value={draftTitle}
                                        onChange={(event) =>
                                            setDraftTitle(
                                                event.currentTarget.value,
                                            )
                                        }
                                        onBlur={commitRename}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                commitRename();
                                            }
                                            if (event.key === "Escape") {
                                                event.preventDefault();
                                                cancelRename();
                                            }
                                        }}
                                        className="min-w-0 flex-1 bg-transparent outline-none"
                                        style={{
                                            border: "none",
                                            color: "inherit",
                                        }}
                                    />
                                ) : (
                                    <span className="min-w-0 flex-1 truncate">
                                        {tab.title}
                                    </span>
                                )}
                            </button>
                            <button
                                type="button"
                                aria-label={`Close ${tab.title}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onCloseTab(tab.id);
                                }}
                                className="flex w-7 items-center justify-center text-[10px]"
                                style={{
                                    border: "none",
                                    borderRadius: 0,
                                    backgroundColor: tab.isActive
                                        ? "var(--bg-primary)"
                                        : "var(--bg-secondary)",
                                    color: "var(--text-secondary)",
                                }}
                                title={`Close ${tab.title}`}
                            >
                                <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 10 10"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                >
                                    <path d="M2 2L8 8M8 2L2 8" />
                                </svg>
                            </button>
                        </div>
                    );
                })}
            </div>

            <div className="flex items-center self-center gap-2 mt-0.5">
                <IconButton title="New Terminal Tab" onClick={onNewTab}>
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                </IconButton>
                <IconButton
                    title="Clear"
                    onClick={onClear}
                    disabled={!canClear}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                </IconButton>
                <IconButton title="Restart" onClick={onRestart}>
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                </IconButton>
                <IconButton title="Hide" onClick={onHide}>
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </IconButton>
            </div>

            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={(() => {
                        const tab = tabs.find(
                            (entry) => entry.id === contextMenu.payload.tabId,
                        );
                        if (!tab) return [];

                        return [
                            {
                                label: "Rename tab",
                                action: () => beginRename(tab.id),
                            },
                            {
                                label: "Duplicate tab",
                                action: () => onDuplicateTab(tab.id),
                            },
                            {
                                label: "Restart tab",
                                action: () => onRestartTab(tab.id),
                            },
                            {
                                label: "Reset title",
                                action: () => onResetTabTitle(tab.id),
                                disabled: !tab.hasCustomTitle,
                            },
                            { type: "separator" as const },
                            {
                                label: "Close others",
                                action: () => onCloseOthers(tab.id),
                                disabled: tabs.length <= 1,
                            },
                            {
                                label: "Close tab",
                                action: () => onCloseTab(tab.id),
                            },
                        ];
                    })()}
                />
            )}
        </div>
    );
}
