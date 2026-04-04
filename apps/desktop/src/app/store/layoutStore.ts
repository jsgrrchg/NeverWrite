import { create } from "zustand";
import { type SidebarView } from "../../components/layout/ActivityBar";
import { safeStorageGetItem, safeStorageSetItem } from "../utils/safeStorage";
import { logWarn } from "../utils/runtimeLog";

const SIDEBAR_WIDTH_KEY = "vaultai.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "vaultai.sidebar.collapsed";
const SIDEBAR_VIEW_KEY = "vaultai.sidebar.view";
export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 2000;

const RIGHT_PANEL_WIDTH_KEY = "vaultai.rightpanel.width";
const RIGHT_PANEL_COLLAPSED_KEY = "vaultai.rightpanel.collapsed";
const RIGHT_PANEL_VIEW_KEY = "vaultai.rightpanel.view";
export const DEFAULT_RIGHT_PANEL_WIDTH = 280;
export const MIN_RIGHT_PANEL_WIDTH = 200;
export const MAX_RIGHT_PANEL_WIDTH = 2000;
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 240;
export const MIN_BOTTOM_PANEL_HEIGHT = 160;
export const MAX_BOTTOM_PANEL_HEIGHT_RATIO = 0.45;

const BOTTOM_PANEL_HEIGHT_KEY = "vaultai.bottompanel.height";
const BOTTOM_PANEL_COLLAPSED_KEY = "vaultai.bottompanel.collapsed";
const BOTTOM_PANEL_VIEW_KEY = "vaultai.bottompanel.view";

const SIDEBAR_VIEWS: SidebarView[] = [
    "files",
    "search",
    "tags",
    "bookmarks",
    "maps",
];
const RIGHT_PANEL_VIEWS = ["links", "outline", "chat"] as const;
const BOTTOM_PANEL_VIEWS = ["terminal"] as const;

type RightPanelView = (typeof RIGHT_PANEL_VIEWS)[number];
type BottomPanelView = (typeof BOTTOM_PANEL_VIEWS)[number];

interface LayoutStore {
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
    bottomPanelCollapsed: boolean;
    bottomPanelHeight: number;
    bottomPanelView: BottomPanelView;
    toggleBottomPanel: () => void;
    showBottomPanelAtHeight: (height: number) => void;
    collapseBottomPanelToHeight: (height: number) => void;
    activateBottomView: (view: BottomPanelView) => void;
}

type LayoutSnapshot = Pick<
    LayoutStore,
    | "sidebarCollapsed"
    | "sidebarWidth"
    | "sidebarView"
    | "rightPanelCollapsed"
    | "rightPanelWidth"
    | "rightPanelView"
    | "bottomPanelCollapsed"
    | "bottomPanelHeight"
    | "bottomPanelView"
>;

function clampSidebarWidth(width: number) {
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

function clampRightPanelWidth(width: number) {
    return Math.max(
        MIN_RIGHT_PANEL_WIDTH,
        Math.min(MAX_RIGHT_PANEL_WIDTH, width),
    );
}

function getMaxBottomPanelHeight() {
    if (typeof window === "undefined") return 2000;
    return Math.max(
        MIN_BOTTOM_PANEL_HEIGHT,
        Math.round(window.innerHeight * MAX_BOTTOM_PANEL_HEIGHT_RATIO),
    );
}

function clampBottomPanelHeight(height: number) {
    return Math.max(
        MIN_BOTTOM_PANEL_HEIGHT,
        Math.min(getMaxBottomPanelHeight(), Math.round(height)),
    );
}

function parseStoredNumber(
    key: string,
    fallback: number,
    clamp: (value: number) => number,
) {
    const raw = safeStorageGetItem(key);
    if (!raw) return fallback;

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : fallback;
}

function readHydratedLayoutSnapshot(): LayoutSnapshot {
    const sidebarViewRaw = safeStorageGetItem(SIDEBAR_VIEW_KEY);
    const rightPanelViewRaw = safeStorageGetItem(RIGHT_PANEL_VIEW_KEY);
    const bottomPanelViewRaw = safeStorageGetItem(BOTTOM_PANEL_VIEW_KEY);
    const bottomPanelCollapsedRaw = safeStorageGetItem(
        BOTTOM_PANEL_COLLAPSED_KEY,
    );

    return {
        sidebarCollapsed: safeStorageGetItem(SIDEBAR_COLLAPSED_KEY) === "true",
        sidebarWidth: parseStoredNumber(
            SIDEBAR_WIDTH_KEY,
            DEFAULT_SIDEBAR_WIDTH,
            clampSidebarWidth,
        ),
        sidebarView: SIDEBAR_VIEWS.includes(sidebarViewRaw as SidebarView)
            ? (sidebarViewRaw as SidebarView)
            : "files",
        rightPanelCollapsed:
            safeStorageGetItem(RIGHT_PANEL_COLLAPSED_KEY) === "true",
        rightPanelWidth: parseStoredNumber(
            RIGHT_PANEL_WIDTH_KEY,
            DEFAULT_RIGHT_PANEL_WIDTH,
            clampRightPanelWidth,
        ),
        rightPanelView: RIGHT_PANEL_VIEWS.includes(
            rightPanelViewRaw as RightPanelView,
        )
            ? (rightPanelViewRaw as RightPanelView)
            : "outline",
        bottomPanelCollapsed:
            bottomPanelCollapsedRaw === null
                ? true
                : bottomPanelCollapsedRaw === "true",
        bottomPanelHeight: parseStoredNumber(
            BOTTOM_PANEL_HEIGHT_KEY,
            DEFAULT_BOTTOM_PANEL_HEIGHT,
            clampBottomPanelHeight,
        ),
        bottomPanelView: BOTTOM_PANEL_VIEWS.includes(
            bottomPanelViewRaw as BottomPanelView,
        )
            ? (bottomPanelViewRaw as BottomPanelView)
            : "terminal",
    };
}

function persistBoolean(key: string, value: boolean) {
    safeStorageSetItem(key, String(value));
}

function persistNumber(key: string, value: number) {
    safeStorageSetItem(key, String(value));
}

function createDefaultState(): LayoutSnapshot {
    return {
        sidebarCollapsed: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        sidebarView: "files",
        rightPanelCollapsed: false,
        rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
        rightPanelView: "outline",
        bottomPanelCollapsed: true,
        bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
        bottomPanelView: "terminal",
    };
}

export const useLayoutStore = create<LayoutStore>((set) => ({
    ...createDefaultState(),
    rightPanelExpanded: false,
    setSidebarView: (view) => {
        safeStorageSetItem(SIDEBAR_VIEW_KEY, view);
        set({ sidebarView: view });
    },
    toggleSidebar: () =>
        set((state) => {
            const collapsed = !state.sidebarCollapsed;
            persistBoolean(SIDEBAR_COLLAPSED_KEY, collapsed);
            return { sidebarCollapsed: collapsed };
        }),
    collapseSidebar: () => {
        persistBoolean(SIDEBAR_COLLAPSED_KEY, true);
        set({ sidebarCollapsed: true });
    },
    expandSidebar: () => {
        persistBoolean(SIDEBAR_COLLAPSED_KEY, false);
        set({ sidebarCollapsed: false });
    },
    setSidebarWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistNumber(SIDEBAR_WIDTH_KEY, nextWidth);
        set({ sidebarWidth: nextWidth });
    },
    showSidebarAtWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistNumber(SIDEBAR_WIDTH_KEY, nextWidth);
        persistBoolean(SIDEBAR_COLLAPSED_KEY, false);
        set({ sidebarWidth: nextWidth, sidebarCollapsed: false });
    },
    collapseSidebarToWidth: (width) => {
        const nextWidth = clampSidebarWidth(width);
        persistNumber(SIDEBAR_WIDTH_KEY, nextWidth);
        persistBoolean(SIDEBAR_COLLAPSED_KEY, true);
        set({ sidebarWidth: nextWidth, sidebarCollapsed: true });
    },
    toggleRightPanel: () =>
        set((state) => {
            const collapsed = !state.rightPanelCollapsed;
            persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, collapsed);
            return {
                rightPanelCollapsed: collapsed,
                rightPanelExpanded: false,
            };
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
                persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, false);
                safeStorageSetItem(RIGHT_PANEL_VIEW_KEY, view);
                return {
                    rightPanelCollapsed: false,
                    rightPanelExpanded: false,
                    rightPanelView: view,
                };
            }
            if (state.rightPanelView === view) {
                persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, true);
                return { rightPanelCollapsed: true, rightPanelExpanded: false };
            }
            safeStorageSetItem(RIGHT_PANEL_VIEW_KEY, view);
            return {
                rightPanelView: view,
                rightPanelExpanded:
                    view === "chat" ? state.rightPanelExpanded : false,
            };
        }),
    showRightPanelAtWidth: (width) => {
        const nextWidth = clampRightPanelWidth(width);
        persistNumber(RIGHT_PANEL_WIDTH_KEY, nextWidth);
        persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, false);
        set({
            rightPanelWidth: nextWidth,
            rightPanelCollapsed: false,
            rightPanelExpanded: false,
        });
    },
    collapseRightPanelToWidth: (width) => {
        const nextWidth = clampRightPanelWidth(width);
        persistNumber(RIGHT_PANEL_WIDTH_KEY, nextWidth);
        persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, true);
        set({
            rightPanelWidth: nextWidth,
            rightPanelCollapsed: true,
            rightPanelExpanded: false,
        });
    },
    toggleBottomPanel: () =>
        set((state) => {
            const collapsed = !state.bottomPanelCollapsed;
            persistBoolean(BOTTOM_PANEL_COLLAPSED_KEY, collapsed);
            return { bottomPanelCollapsed: collapsed };
        }),
    showBottomPanelAtHeight: (height) => {
        const nextHeight = clampBottomPanelHeight(height);
        persistNumber(BOTTOM_PANEL_HEIGHT_KEY, nextHeight);
        persistBoolean(BOTTOM_PANEL_COLLAPSED_KEY, false);
        set({
            bottomPanelHeight: nextHeight,
            bottomPanelCollapsed: false,
        });
    },
    collapseBottomPanelToHeight: (height) => {
        const nextHeight = clampBottomPanelHeight(height);
        persistNumber(BOTTOM_PANEL_HEIGHT_KEY, nextHeight);
        persistBoolean(BOTTOM_PANEL_COLLAPSED_KEY, true);
        set({
            bottomPanelHeight: nextHeight,
            bottomPanelCollapsed: true,
        });
    },
    activateBottomView: (view) => {
        safeStorageSetItem(BOTTOM_PANEL_VIEW_KEY, view);
        persistBoolean(BOTTOM_PANEL_COLLAPSED_KEY, false);
        set({
            bottomPanelView: view,
            bottomPanelCollapsed: false,
        });
    },
}));

let layoutHydrated = false;

export function hydrateLayoutStore() {
    if (layoutHydrated) return;
    layoutHydrated = true;

    try {
        useLayoutStore.setState(readHydratedLayoutSnapshot());
    } catch (error) {
        logWarn("layout-store", "Failed to hydrate layout store", error, {
            onceKey: "hydrate-layout-store",
        });
    }
}
