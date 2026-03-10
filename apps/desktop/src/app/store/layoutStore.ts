import { create } from "zustand";
import { type SidebarView } from "../../components/layout/ActivityBar";

// --- Left sidebar ---
const SIDEBAR_WIDTH_KEY = "vaultai.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "vaultai.sidebar.collapsed";
const SIDEBAR_VIEW_KEY = "vaultai.sidebar.view";
export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;

function clampSidebarWidth(width: number) {
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth() {
    if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
        ? clampSidebarWidth(parsed)
        : DEFAULT_SIDEBAR_WIDTH;
}

function persistSidebarWidth(width: number) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
}

function readStoredSidebarCollapsed() {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function persistSidebarCollapsed(collapsed: boolean) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

const SIDEBAR_VIEWS: SidebarView[] = ["files", "search", "tags"];
function readStoredSidebarView(): SidebarView {
    if (typeof window === "undefined") return "files";
    const raw = window.localStorage.getItem(SIDEBAR_VIEW_KEY);
    return SIDEBAR_VIEWS.includes(raw as SidebarView)
        ? (raw as SidebarView)
        : "files";
}

function persistSidebarView(view: SidebarView) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_VIEW_KEY, view);
}

// --- Right panel ---
const RIGHT_PANEL_WIDTH_KEY = "vaultai.rightpanel.width";
const RIGHT_PANEL_COLLAPSED_KEY = "vaultai.rightpanel.collapsed";
const RIGHT_PANEL_VIEW_KEY = "vaultai.rightpanel.view";
export const DEFAULT_RIGHT_PANEL_WIDTH = 280;
export const MIN_RIGHT_PANEL_WIDTH = 200;
export const MAX_RIGHT_PANEL_WIDTH = 2000;

function clampRightPanelWidth(width: number) {
    return Math.max(
        MIN_RIGHT_PANEL_WIDTH,
        Math.min(MAX_RIGHT_PANEL_WIDTH, width),
    );
}

function readStoredRightPanelWidth() {
    if (typeof window === "undefined") return DEFAULT_RIGHT_PANEL_WIDTH;
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
    if (!raw) return DEFAULT_RIGHT_PANEL_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
        ? clampRightPanelWidth(parsed)
        : DEFAULT_RIGHT_PANEL_WIDTH;
}

function persistRightPanelWidth(width: number) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(width));
}

function readStoredRightPanelCollapsed() {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === "true";
}

function persistRightPanelCollapsed(collapsed: boolean) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, String(collapsed));
}

const RIGHT_PANEL_VIEWS = ["links", "outline", "chat"] as const;
type RightPanelView = (typeof RIGHT_PANEL_VIEWS)[number];

function readStoredRightPanelView(): RightPanelView {
    if (typeof window === "undefined") return "outline";
    const raw = window.localStorage.getItem(RIGHT_PANEL_VIEW_KEY);
    return RIGHT_PANEL_VIEWS.includes(raw as RightPanelView)
        ? (raw as RightPanelView)
        : "outline";
}

function persistRightPanelView(view: RightPanelView) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RIGHT_PANEL_VIEW_KEY, view);
}

interface LayoutStore {
    // Left sidebar
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    sidebarView: SidebarView;
    setSidebarView: (view: SidebarView) => void;
    toggleSidebar: () => void;
    collapseSidebar: () => void;
    expandSidebar: () => void;
    setSidebarWidth: (width: number) => void;
    showSidebarAtWidth: (width: number) => void;
    collapseSidebarToWidth: (width: number) => void;
    // Right panel
    rightPanelCollapsed: boolean;
    rightPanelExpanded: boolean;
    rightPanelWidth: number;
    rightPanelView: RightPanelView;
    toggleRightPanel: () => void;
    setRightPanelExpanded: (expanded: boolean) => void;
    toggleRightPanelExpanded: () => void;
    activateRightView: (view: "links" | "outline" | "chat") => void;
    showRightPanelAtWidth: (width: number) => void;
    collapseRightPanelToWidth: (width: number) => void;
}

const initialSidebarWidth = readStoredSidebarWidth();
const initialSidebarCollapsed = readStoredSidebarCollapsed();
const initialSidebarView = readStoredSidebarView();
const initialRightPanelWidth = readStoredRightPanelWidth();
const initialRightPanelCollapsed = readStoredRightPanelCollapsed();
const initialRightPanelView = readStoredRightPanelView();

export const useLayoutStore = create<LayoutStore>((set) => ({
    // Left sidebar
    sidebarCollapsed: initialSidebarCollapsed,
    sidebarWidth: initialSidebarWidth,
    sidebarView: initialSidebarView,
    setSidebarView: (view) => {
        persistSidebarView(view);
        set({ sidebarView: view });
    },
    toggleSidebar: () =>
        set((state) => {
            const collapsed = !state.sidebarCollapsed;
            persistSidebarCollapsed(collapsed);
            return { sidebarCollapsed: collapsed };
        }),
    collapseSidebar: () => {
        persistSidebarCollapsed(true);
        set({ sidebarCollapsed: true });
    },
    expandSidebar: () => {
        persistSidebarCollapsed(false);
        set({ sidebarCollapsed: false });
    },
    setSidebarWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistSidebarWidth(nextWidth);
        set({ sidebarWidth: nextWidth });
    },
    showSidebarAtWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistSidebarWidth(nextWidth);
        persistSidebarCollapsed(false);
        set({ sidebarWidth: nextWidth, sidebarCollapsed: false });
    },
    collapseSidebarToWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistSidebarWidth(nextWidth);
        persistSidebarCollapsed(true);
        set({ sidebarWidth: nextWidth, sidebarCollapsed: true });
    },
    // Right panel
    rightPanelCollapsed: initialRightPanelCollapsed,
    rightPanelExpanded: false,
    rightPanelWidth: initialRightPanelWidth,
    rightPanelView: initialRightPanelView,
    toggleRightPanel: () =>
        set((state) => {
            const collapsed = !state.rightPanelCollapsed;
            persistRightPanelCollapsed(collapsed);
            return { rightPanelCollapsed: collapsed, rightPanelExpanded: false };
        }),
    setRightPanelExpanded: (expanded) =>
        set((state) => ({
            rightPanelExpanded: expanded,
            rightPanelCollapsed: expanded ? false : state.rightPanelCollapsed,
        })),
    toggleRightPanelExpanded: () =>
        set((state) => ({
            rightPanelExpanded: !state.rightPanelExpanded,
            rightPanelCollapsed: state.rightPanelExpanded
                ? state.rightPanelCollapsed
                : false,
        })),
    activateRightView: (view) =>
        set((state) => {
            if (state.rightPanelCollapsed) {
                persistRightPanelCollapsed(false);
                persistRightPanelView(view);
                return {
                    rightPanelCollapsed: false,
                    rightPanelExpanded: false,
                    rightPanelView: view,
                };
            }
            if (state.rightPanelView === view) {
                persistRightPanelCollapsed(true);
                return { rightPanelCollapsed: true, rightPanelExpanded: false };
            }
            persistRightPanelView(view);
            return {
                rightPanelView: view,
                rightPanelExpanded:
                    view === "chat" ? state.rightPanelExpanded : false,
            };
        }),
    showRightPanelAtWidth: (width) => {
        const nextWidth = clampRightPanelWidth(width);
        persistRightPanelWidth(nextWidth);
        persistRightPanelCollapsed(false);
        set({
            rightPanelWidth: nextWidth,
            rightPanelCollapsed: false,
            rightPanelExpanded: false,
        });
    },
    collapseRightPanelToWidth: (width) => {
        const nextWidth = clampRightPanelWidth(width);
        persistRightPanelWidth(nextWidth);
        persistRightPanelCollapsed(true);
        set({
            rightPanelWidth: nextWidth,
            rightPanelCollapsed: true,
            rightPanelExpanded: false,
        });
    },
}));
