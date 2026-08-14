import { useCallback } from "react";
import { useLayoutStore } from "../../app/store/layoutStore";
import { getDesktopPlatform } from "../../app/utils/platform";
import { SidebarTabs } from "./SidebarTabs";
import { SidebarViewContent } from "./SidebarViewContent";
import { getSidebarViews, type SidebarView } from "./sidebarViews";

const PLATFORM = getDesktopPlatform();
const USES_NATIVE_TITLEBAR_OVERLAY =
    PLATFORM === "windows" || PLATFORM === "linux";

export function RightSidebarShell() {
    const activeView = useLayoutStore((state) => state.activeSidebarView.right);
    const placement = useLayoutStore((state) => state.movableSidebarPlacement);
    const activateSidebarView = useLayoutStore(
        (state) => state.activateSidebarView,
    );
    const toggleRightPanel = useLayoutStore((state) => state.toggleRightPanel);
    const views = getSidebarViews("right", placement);
    const compactContextualViews = views.some(
        (view) => view === "files" || view === "agents",
    );
    const selectView = useCallback(
        (view: SidebarView) => activateSidebarView("right", view),
        [activateSidebarView],
    );

    return (
        <div
            className="flex h-full min-h-0 flex-col overflow-hidden"
            data-testid="right-sidebar-shell"
            data-sidebar-side="right"
        >
            {USES_NATIVE_TITLEBAR_OVERLAY && (
                <div
                    aria-hidden="true"
                    data-right-panel-titlebar-inset
                    style={
                        {
                            height: 34,
                            flexShrink: 0,
                            WebkitAppRegion: "drag",
                            backgroundColor: "var(--sidebar-vibrancy-tint)",
                        } as React.CSSProperties
                    }
                />
            )}
            <div
                className="flex items-center gap-1"
                style={{ padding: "8px 8px 6px", flexShrink: 0 }}
            >
                <SidebarTabs
                    side="right"
                    views={views}
                    activeView={activeView}
                    compactContextualViews={compactContextualViews}
                    onSelect={selectView}
                />
                <button
                    type="button"
                    onClick={toggleRightPanel}
                    title="Hide right panel"
                    aria-label="Hide right panel"
                    className="ub-chrome-btn flex items-center justify-center shrink-0 rounded-md"
                    style={{
                        width: 26,
                        height: 26,
                        border: "1px solid transparent",
                        background: "transparent",
                        color: "var(--text-secondary)",
                        opacity: 0.82,
                    }}
                >
                    <svg
                        width="16"
                        height="16"
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
            <div className="min-h-0 flex-1 overflow-hidden">
                <SidebarViewContent view={activeView} />
            </div>
        </div>
    );
}
