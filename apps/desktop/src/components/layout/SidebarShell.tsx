import {
    useCallback,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@neverwrite/runtime";
import { useLayoutStore, type SidebarView } from "../../app/store/layoutStore";
import {
    getDesktopPlatform,
    getTrafficLightSpacerWidth,
} from "../../app/utils/platform";
import { useAppUpdateStore } from "../../features/updates/store";
import { FileTree } from "../../features/vault/FileTree";
import { TagsPanel } from "../../features/tags/TagsPanel";
import { BookmarksPanel } from "../../features/bookmarks/BookmarksPanel";
import { MapsPanel } from "../../features/maps/MapsPanel";
import { AgentsSidebarPanel } from "../../features/ai/AgentsSidebarPanel";
import { VaultSwitcher } from "../../features/vault/VaultSwitcher";

// A single unified translucent left pane that replaces both the horizontal
// chrome bar's sidebar toggle and the vertical ActivityBar rail. It renders
// four regions top-to-bottom: drag header with collapse button, tab row,
// view body, and the VaultSwitcher footer (which hosts Settings entry).
// macOS vibrancy shows through via the already-transparent ancestors
// (see AppLayout + index.css).

const IS_MACOS = getDesktopPlatform() === "macos";

// Primary tabs are labeled; secondary ones stay compact (icon-only) so all
// fit on a single row without truncation at default sidebar width.
const PRIMARY_TABS: SidebarView[] = ["files", "agents"];
const SECONDARY_TABS: SidebarView[] = ["tags", "bookmarks", "maps"];

const TAB_LABELS: Record<SidebarView, string> = {
    files: "Files",
    tags: "Tags",
    bookmarks: "Bookmarks",
    maps: "Maps",
    agents: "Agents",
};

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow()
        .startDragging()
        .catch(() => {});
}

function SidebarTabIcon({ view }: { view: SidebarView }) {
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
    }
}

function SidebarTabButton({
    view,
    active,
    onSelect,
    compact = false,
}: {
    view: SidebarView;
    active: boolean;
    onSelect: (view: SidebarView) => void;
    compact?: boolean;
}) {
    return (
        <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onSelect(view)}
            title={TAB_LABELS[view]}
            data-active={active || undefined}
            data-sidebar-tab={view}
            className="no-drag flex items-center justify-center gap-1.5 text-[11px] font-medium rounded-md"
            style={{
                flex: compact ? "0 0 auto" : 1,
                minWidth: 0,
                height: 28,
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
                    "background-color 120ms ease, color 120ms ease, border-color 120ms ease",
            }}
        >
            <SidebarTabIcon view={view} />
            {!compact && (
                <span className="truncate">{TAB_LABELS[view]}</span>
            )}
        </button>
    );
}

export interface SidebarShellProps {
    onOpenSettings: (section?: string) => void;
}

export function SidebarShell({ onOpenSettings }: SidebarShellProps) {
    const sidebarView = useLayoutStore((s) => s.sidebarView);
    const setSidebarView = useLayoutStore((s) => s.setSidebarView);
    const expandSidebar = useLayoutStore((s) => s.expandSidebar);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

    const updateAvailable = useAppUpdateStore((state) => !!state.status?.update);

    const trafficLightInsetHeight = IS_MACOS
        ? Math.max(28, getTrafficLightSpacerWidth() / 2 + 12)
        : 0;

    const handleSelectView = useCallback(
        (view: SidebarView) => {
            setSidebarView(view);
            expandSidebar();
        },
        [expandSidebar, setSidebarView],
    );

    const currentView = sidebarView;

    return (
        <div
            className="flex h-full flex-col overflow-hidden"
            data-testid="sidebar-shell"
        >
            {/* Traffic-light drag inset (macOS only). Keeps the window
                draggable from the top of the sidebar when the horizontal
                chrome bar is gone. */}
            {/* Top row: sits alongside the macOS traffic-light cut-out and
                hosts an oversized collapse button on the right. The empty
                space is a drag region so the window is still draggable from
                the top of the sidebar. */}
            <div
                data-sidebar-drag-inset
                onMouseDown={startWindowDrag}
                className="flex items-center justify-end"
                style={{
                    height: Math.max(trafficLightInsetHeight, 38),
                    padding: "0 8px",
                    flexShrink: 0,
                    WebkitAppRegion: "drag",
                } as CSSProperties}
            >
                <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={toggleSidebar}
                    title="Hide sidebar"
                    aria-label="Hide sidebar"
                    className="no-drag ub-chrome-btn flex items-center justify-center rounded-md"
                    style={{
                        width: 32,
                        height: 32,
                        border: "1px solid transparent",
                        background: "transparent",
                        color: "var(--text-secondary)",
                        opacity: 0.82,
                    }}
                >
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <rect x="2" y="2.5" width="12" height="11" rx="2.2" />
                        <path d="M6 2.5v11" />
                    </svg>
                </button>
            </div>

            {/* Tab row: primary views carry a label, secondary views stay
                compact (icon-only) so all five fit on one line. */}
            <div
                className="flex items-center gap-1"
                style={{ padding: "0 8px 8px", flexShrink: 0 }}
            >
                {PRIMARY_TABS.map((view) => (
                    <SidebarTabButton
                        key={view}
                        view={view}
                        active={currentView === view}
                        onSelect={handleSelectView}
                    />
                ))}
                {SECONDARY_TABS.map((view) => (
                    <SidebarTabButton
                        key={view}
                        view={view}
                        active={currentView === view}
                        onSelect={handleSelectView}
                        compact
                    />
                ))}
            </div>

            {/* View body. Fills remaining space above the footer. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {currentView === "files" ? (
                    <FileTree />
                ) : currentView === "tags" ? (
                    <TagsPanel />
                ) : currentView === "bookmarks" ? (
                    <BookmarksPanel />
                ) : currentView === "agents" ? (
                    <AgentsSidebarPanel />
                ) : (
                    <MapsPanel />
                )}
            </div>

            {/* Footer: vault switcher hosts the Settings entry and its
                update badge via its dropdown. Maps hides the switcher
                because it runs its own multi-context chrome. */}
            {currentView !== "maps" && (
                <VaultSwitcher
                    onOpenSettings={onOpenSettings}
                    updateAvailable={updateAvailable}
                />
            )}
        </div>
    );
}
