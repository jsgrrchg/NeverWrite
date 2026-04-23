import { create } from "zustand";
import { safeStorageGetItem, safeStorageSetItem } from "../utils/safeStorage";
import { logWarn } from "../utils/runtimeLog";

// Canonical list of left-sidebar views. Lives in the layout store (instead
// of an obsolete component file) so renderer components can import the type
// without coupling to a specific shell implementation.
export type SidebarView = "files" | "tags" | "bookmarks" | "maps";

const SIDEBAR_WIDTH_KEY = "neverwrite.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "neverwrite.sidebar.collapsed";
const SIDEBAR_VIEW_KEY = "neverwrite.sidebar.view";
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 280;
export const MAX_SIDEBAR_WIDTH = 2000;

const RIGHT_PANEL_WIDTH_KEY = "neverwrite.rightpanel.width";
const RIGHT_PANEL_COLLAPSED_KEY = "neverwrite.rightpanel.collapsed";
const RIGHT_PANEL_VIEW_KEY = "neverwrite.rightpanel.view";
export const DEFAULT_RIGHT_PANEL_WIDTH = 280;
export const MIN_RIGHT_PANEL_WIDTH = 200;
export const MAX_RIGHT_PANEL_WIDTH = 2000;

const EDITOR_PANE_SIZES_KEY = "neverwrite.editor-pane.sizes";

const SIDEBAR_VIEWS: SidebarView[] = ["files", "tags", "bookmarks", "maps"];
const RIGHT_PANEL_VIEWS = ["links", "outline", "chat"] as const;

type RightPanelView = (typeof RIGHT_PANEL_VIEWS)[number];

const DEFAULT_EDITOR_PANE_SIZES = [1];

function normalizeEditorPaneSizesForCount(count: number, sizes?: number[]) {
    const normalizedCount = Math.max(1, Math.floor(count) || 1);
    const incoming = (sizes ?? []).filter(
        (value) => Number.isFinite(value) && value > 0,
    );

    if (incoming.length === normalizedCount) {
        const total = incoming.reduce((sum, value) => sum + value, 0);
        if (total > 0) {
            return incoming.map((value) => value / total);
        }
    }

    return Array.from({ length: normalizedCount }, () => 1 / normalizedCount);
}

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
    editorPaneSizes: number[];
    ensureEditorPaneSizeCount: (count: number) => void;
    setEditorPaneSizes: (count: number, sizes: number[]) => void;
}

type LayoutSnapshot = Pick<
    LayoutStore,
    | "sidebarCollapsed"
    | "sidebarWidth"
    | "sidebarView"
    | "rightPanelCollapsed"
    | "rightPanelWidth"
    | "rightPanelView"
    | "editorPaneSizes"
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
        editorPaneSizes: (() => {
            try {
                const raw = safeStorageGetItem(EDITOR_PANE_SIZES_KEY);
                if (!raw) return DEFAULT_EDITOR_PANE_SIZES;
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed)
                    ? normalizeEditorPaneSizesForCount(parsed.length, parsed)
                    : DEFAULT_EDITOR_PANE_SIZES;
            } catch {
                return DEFAULT_EDITOR_PANE_SIZES;
            }
        })(),
    };
}

function persistBoolean(key: string, value: boolean) {
    safeStorageSetItem(key, String(value));
}

function persistNumber(key: string, value: number) {
    safeStorageSetItem(key, String(value));
}

function persistEditorPaneSizes(value: number[]) {
    safeStorageSetItem(EDITOR_PANE_SIZES_KEY, JSON.stringify(value));
}

function createDefaultState(): LayoutSnapshot {
    return {
        sidebarCollapsed: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        sidebarView: "files",
        rightPanelCollapsed: false,
        rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
        rightPanelView: "outline",
        editorPaneSizes: DEFAULT_EDITOR_PANE_SIZES,
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
    ensureEditorPaneSizeCount: (count) =>
        set((state) => {
            const nextSizes = normalizeEditorPaneSizesForCount(
                count,
                state.editorPaneSizes,
            );
            const unchanged =
                nextSizes.length === state.editorPaneSizes.length &&
                nextSizes.every(
                    (value, index) => value === state.editorPaneSizes[index],
                );
            if (unchanged) {
                return state;
            }
            persistEditorPaneSizes(nextSizes);
            return { editorPaneSizes: nextSizes };
        }),
    setEditorPaneSizes: (count, sizes) => {
        const nextSizes = normalizeEditorPaneSizesForCount(count, sizes);
        persistEditorPaneSizes(nextSizes);
        set({ editorPaneSizes: nextSizes });
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
