import {
    useCallback,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@neverwrite/runtime";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    getDesktopPlatform,
    getTrafficLightSpacerWidth,
} from "../../app/utils/platform";
import { useAppUpdateStore } from "../../features/updates/store";
import { VaultSwitcher } from "../../features/vault/VaultSwitcher";
import { SidebarTabs } from "./SidebarTabs";
import { SidebarViewContent } from "./SidebarViewContent";
import { getSidebarViews, type SidebarView } from "./sidebarViews";

const IS_MACOS = getDesktopPlatform() === "macos";

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow()
        .startDragging()
        .catch(() => {});
}

export interface SidebarShellProps {
    onOpenSettings: (section?: string) => void;
}

export function SidebarShell({ onOpenSettings }: SidebarShellProps) {
    const activeView = useLayoutStore((state) => state.activeSidebarView.left);
    const placement = useLayoutStore((state) => state.movableSidebarPlacement);
    const activateSidebarView = useLayoutStore(
        (state) => state.activateSidebarView,
    );
    const moveSidebarView = useLayoutStore((state) => state.moveSidebarView);
    const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
    const updateAvailable = useAppUpdateStore(
        (state) => !!state.status?.update,
    );
    const views = getSidebarViews("left", placement);
    const trafficLightInsetHeight = IS_MACOS
        ? Math.max(28, getTrafficLightSpacerWidth() / 2 + 12)
        : 0;
    const selectView = useCallback(
        (view: SidebarView) => activateSidebarView("left", view),
        [activateSidebarView],
    );

    return (
        <div
            className="flex h-full flex-col overflow-hidden"
            data-testid="sidebar-shell"
            data-sidebar-side="left"
        >
            <div
                data-sidebar-drag-inset
                onMouseDown={startWindowDrag}
                className="flex items-center justify-end"
                style={
                    {
                        height: Math.max(trafficLightInsetHeight, 38),
                        padding: "0 8px",
                        flexShrink: 0,
                        WebkitAppRegion: "drag",
                    } as CSSProperties
                }
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
            <div
                className="flex items-center gap-1"
                style={{ padding: "0 8px 8px", flexShrink: 0 }}
            >
                <SidebarTabs
                    side="left"
                    views={views}
                    activeView={activeView}
                    onSelect={selectView}
                    onMove={moveSidebarView}
                />
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <SidebarViewContent view={activeView} />
            </div>
            {activeView !== "maps" && (
                <VaultSwitcher
                    onOpenSettings={onOpenSettings}
                    updateAvailable={updateAvailable}
                />
            )}
        </div>
    );
}
