import { create } from "zustand";

// --- Left sidebar ---
const SIDEBAR_WIDTH_KEY = "vaultai.sidebar.width";
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

// --- Right panel ---
const RIGHT_PANEL_WIDTH_KEY = "vaultai.rightpanel.width";
export const DEFAULT_RIGHT_PANEL_WIDTH = 280;
export const MIN_RIGHT_PANEL_WIDTH = 200;
export const MAX_RIGHT_PANEL_WIDTH = 480;

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

interface LayoutStore {
    // Left sidebar
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    toggleSidebar: () => void;
    collapseSidebar: () => void;
    expandSidebar: () => void;
    setSidebarWidth: (width: number) => void;
    showSidebarAtWidth: (width: number) => void;
    collapseSidebarToWidth: (width: number) => void;
    // Right panel
    rightPanelCollapsed: boolean;
    rightPanelWidth: number;
    rightPanelView: "links" | "chat";
    toggleRightPanel: () => void;
    activateRightView: (view: "links" | "chat") => void;
    showRightPanelAtWidth: (width: number) => void;
    collapseRightPanelToWidth: (width: number) => void;
}

const initialSidebarWidth = readStoredSidebarWidth();
const initialRightPanelWidth = readStoredRightPanelWidth();

export const useLayoutStore = create<LayoutStore>((set) => ({
    // Left sidebar
    sidebarCollapsed: false,
    sidebarWidth: initialSidebarWidth,
    toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    collapseSidebar: () => set({ sidebarCollapsed: true }),
    expandSidebar: () => set({ sidebarCollapsed: false }),
    setSidebarWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistSidebarWidth(nextWidth);
        set({ sidebarWidth: nextWidth });
    },
    showSidebarAtWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistSidebarWidth(nextWidth);
        set({ sidebarWidth: nextWidth, sidebarCollapsed: false });
    },
    collapseSidebarToWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistSidebarWidth(nextWidth);
        set({ sidebarWidth: nextWidth, sidebarCollapsed: true });
    },
    // Right panel
    rightPanelCollapsed: false,
    rightPanelWidth: initialRightPanelWidth,
    rightPanelView: "links",
    toggleRightPanel: () =>
        set((state) => ({
            rightPanelCollapsed: !state.rightPanelCollapsed,
        })),
    activateRightView: (view) =>
        set((state) => {
            if (state.rightPanelCollapsed) {
                return { rightPanelCollapsed: false, rightPanelView: view };
            }
            if (state.rightPanelView === view) {
                return { rightPanelCollapsed: true };
            }
            return { rightPanelView: view };
        }),
    showRightPanelAtWidth: (width) => {
        const nextWidth = clampRightPanelWidth(width);
        persistRightPanelWidth(nextWidth);
        set({ rightPanelWidth: nextWidth, rightPanelCollapsed: false });
    },
    collapseRightPanelToWidth: (width) => {
        const nextWidth = clampRightPanelWidth(width);
        persistRightPanelWidth(nextWidth);
        set({ rightPanelWidth: nextWidth, rightPanelCollapsed: true });
    },
}));
