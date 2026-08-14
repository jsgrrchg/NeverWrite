import { useState, type KeyboardEvent, type MouseEvent } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../context-menu/ContextMenu";
import type { SidebarSide, SidebarView } from "./sidebarViews";
import {
    isMovableSidebarView,
    SIDEBAR_VIEW_CATALOG,
    type MovableSidebarView,
} from "./sidebarViews";

export function SidebarViewIcon({ view }: { view: SidebarView }) {
    const common = {
        width: 14,
        height: 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };
    switch (view) {
        case "files":
            return (
                <svg {...common}>
                    <path d="M4 4h6l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
                </svg>
            );
        case "tags":
            return (
                <svg {...common}>
                    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
                </svg>
            );
        case "bookmarks":
            return (
                <svg {...common}>
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
            );
        case "maps":
            return (
                <svg {...common}>
                    <circle cx="7" cy="12" r="2.5" />
                    <circle cx="17" cy="7" r="2.5" />
                    <circle cx="17" cy="17" r="2.5" />
                    <path d="M9.5 12L14.5 7.5M9.5 12L14.5 16.5" />
                </svg>
            );
        case "agents":
            return (
                <svg {...common}>
                    <path d="M12 3v2" />
                    <rect x="5" y="7" width="14" height="11" rx="3" />
                    <circle cx="9.5" cy="12" r="1" />
                    <circle cx="14.5" cy="12" r="1" />
                    <path d="M9 18v2M15 18v2M3 12h2M19 12h2" />
                </svg>
            );
        case "outline":
            return (
                <svg {...common}>
                    <path d="M4 5h16M7 12h13M10 19h10M4 12h.01M7 19h.01" />
                </svg>
            );
        case "links":
            return (
                <svg {...common}>
                    <path d="M14 4h6v6M20 4l-9 9M10 6H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
                </svg>
            );
    }
}

interface SidebarTabsProps {
    side: SidebarSide;
    views: SidebarView[];
    activeView: SidebarView;
    compactContextualViews?: boolean;
    onSelect: (view: SidebarView) => void;
    onMove?: (view: MovableSidebarView, target: SidebarSide) => void;
}

export function SidebarTabs({
    side,
    views,
    activeView,
    compactContextualViews = false,
    onSelect,
    onMove,
}: SidebarTabsProps) {
    const [menu, setMenu] =
        useState<ContextMenuState<MovableSidebarView> | null>(null);
    const requestContextMenu = (
        view: SidebarView,
        event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>,
    ) => {
        if (!onMove || !isMovableSidebarView(view)) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const pointer = "clientX" in event && event.clientX > 0;
        setMenu({
            payload: view,
            x: pointer ? event.clientX : rect.left,
            y: pointer ? event.clientY : rect.bottom,
        });
    };

    return (
        <>
            <div
                className="flex min-w-0 flex-1 items-center gap-1"
                data-sidebar-tabs={side}
            >
                {views.map((view) => {
                    const definition = SIDEBAR_VIEW_CATALOG[view];
                    const compact =
                        definition.compact ||
                        (compactContextualViews &&
                            (view === "outline" || view === "links"));
                    const active = activeView === view;
                    return (
                        <button
                            key={view}
                            type="button"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => onSelect(view)}
                            onContextMenu={(event) =>
                                requestContextMenu(view, event)
                            }
                            onKeyDown={(event) => {
                                if (
                                    event.key === "ContextMenu" ||
                                    (event.shiftKey && event.key === "F10")
                                ) {
                                    requestContextMenu(view, event);
                                }
                            }}
                            title={definition.label}
                            aria-label={definition.label}
                            data-active={active || undefined}
                            data-sidebar-tab={view}
                            className="no-drag ub-sidebar-tab flex items-center justify-center gap-1.5 text-[11px] font-medium rounded-md"
                            style={{
                                flex: compact ? "0 0 auto" : 1,
                                minWidth: 0,
                                height: side === "left" ? 28 : 26,
                                padding: compact ? "0 8px" : "0 6px",
                                border: active
                                    ? "1px solid color-mix(in srgb, var(--accent) 22%, var(--border))"
                                    : "1px solid transparent",
                                background: active
                                    ? "color-mix(in srgb, var(--bg-primary) 60%, transparent)"
                                    : "transparent",
                                color: active
                                    ? "var(--text-primary)"
                                    : "var(--text-secondary)",
                                boxShadow: active
                                    ? "0 1px 2px rgb(0 0 0 / 0.12)"
                                    : "none",
                                transition:
                                    "background-color 140ms ease-out, color 140ms ease-out, border-color 140ms ease-out, transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 140ms ease-out",
                            }}
                        >
                            <SidebarViewIcon view={view} />
                            {!compact && (
                                <span className="truncate">
                                    {definition.label}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
            {menu && (
                <ContextMenu
                    menu={menu}
                    entries={[
                        {
                            label:
                                side === "left"
                                    ? "Move to Right Sidebar"
                                    : "Move to Left Sidebar",
                            action: () =>
                                onMove?.(
                                    menu.payload,
                                    side === "left" ? "right" : "left",
                                ),
                        },
                    ]}
                    onClose={() => setMenu(null)}
                />
            )}
        </>
    );
}
