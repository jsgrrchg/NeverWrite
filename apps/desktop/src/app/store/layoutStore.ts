import { create } from "zustand";

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

interface LayoutStore {
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    toggleSidebar: () => void;
    collapseSidebar: () => void;
    expandSidebar: () => void;
    setSidebarWidth: (width: number) => void;
    showSidebarAtWidth: (width: number) => void;
    collapseSidebarToWidth: (width: number) => void;
}

const initialSidebarWidth = readStoredSidebarWidth();

export const useLayoutStore = create<LayoutStore>((set) => ({
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
}));
