import { create } from "zustand";
import {
    DEFAULT_MOVABLE_SIDEBAR_PLACEMENT,
    getSidebarFallbackView,
    getSidebarViewMinimumWidth,
    getSidebarViewSide,
    isMovableSidebarView,
    isViewAvailableOnSide,
    normalizeActiveSidebarView,
    normalizeMovableSidebarPlacement,
    type MovableSidebarPlacement,
    type MovableSidebarView,
    type SidebarSide,
    type SidebarView,
} from "../../components/layout/sidebarViews";
import { safeStorageGetItem, safeStorageSetItem } from "../utils/safeStorage";
import { logWarn } from "../utils/runtimeLog";

export type {
    SidebarSide,
    SidebarView,
    MovableSidebarView,
} from "../../components/layout/sidebarViews";

const SIDEBAR_WIDTH_KEY = "neverwrite.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "neverwrite.sidebar.collapsed";
const LEGACY_SIDEBAR_VIEW_KEY = "neverwrite.sidebar.view";
const RIGHT_PANEL_WIDTH_KEY = "neverwrite.rightpanel.width";
const RIGHT_PANEL_COLLAPSED_KEY = "neverwrite.rightpanel.collapsed";
const LEGACY_RIGHT_PANEL_VIEW_KEY = "neverwrite.rightpanel.view";
const ACTIVE_SIDEBAR_VIEWS_KEY = "neverwrite.sidebar.active-views.v1";
const MOVABLE_SIDEBAR_PLACEMENT_KEY = "neverwrite.sidebar.movable-placement.v1";
const EDITOR_PANE_SIZES_KEY = "neverwrite.editor-pane.sizes";

export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 280;
export const MAX_SIDEBAR_WIDTH = 2000;
export const DEFAULT_RIGHT_PANEL_WIDTH = 280;
export const MIN_RIGHT_PANEL_WIDTH = 200;
export const MAX_RIGHT_PANEL_WIDTH = 2000;

const DEFAULT_EDITOR_PANE_SIZES = [1];

export interface ActiveSidebarViews {
    left: SidebarView;
    right: SidebarView;
}

interface LayoutStore {
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    activeSidebarView: ActiveSidebarViews;
    movableSidebarPlacement: MovableSidebarPlacement;
    activateSidebarView: (side: SidebarSide, view: SidebarView) => void;
    showSidebarView: (view: SidebarView) => void;
    moveSidebarView: (view: MovableSidebarView, target: SidebarSide) => void;
    toggleSidebar: () => void;
    collapseSidebar: () => void;
    expandSidebar: () => void;
    setSidebarWidth: (width: number) => void;
    showSidebarAtWidth: (width: number) => void;
    collapseSidebarToWidth: (width: number) => void;
    rightPanelCollapsed: boolean;
    rightPanelExpanded: boolean;
    rightPanelWidth: number;
    toggleRightPanel: () => void;
    setRightPanelExpanded: (expanded: boolean) => void;
    toggleRightPanelExpanded: () => void;
    showRightPanelAtWidth: (width: number) => void;
    collapseRightPanelToWidth: (width: number) => void;
    editorPaneSizes: number[];
    ensureEditorPaneSizeCount: (count: number) => void;
    setEditorPaneSizes: (count: number, sizes: number[]) => void;
    fileTreeScrollTopByVault: Record<string, number>;
    getFileTreeScrollTop: (vaultPath: string | null | undefined) => number;
    setFileTreeScrollTop: (
        vaultPath: string | null | undefined,
        scrollTop: number,
    ) => void;
}

type LayoutSnapshot = Pick<
    LayoutStore,
    | "sidebarCollapsed"
    | "sidebarWidth"
    | "activeSidebarView"
    | "movableSidebarPlacement"
    | "rightPanelCollapsed"
    | "rightPanelWidth"
    | "editorPaneSizes"
>;

function normalizeEditorPaneSizesForCount(count: number, sizes?: number[]) {
    const normalizedCount = Math.max(1, Math.floor(count) || 1);
    const incoming = (sizes ?? []).filter(
        (value) => Number.isFinite(value) && value > 0,
    );
    if (incoming.length === normalizedCount) {
        const total = incoming.reduce((sum, value) => sum + value, 0);
        if (total > 0) return incoming.map((value) => value / total);
    }
    return Array.from({ length: normalizedCount }, () => 1 / normalizedCount);
}

function clampWidth(width: number, minimum: number, maximum: number) {
    return Math.max(minimum, Math.min(maximum, width));
}

function clampSidebarWidth(width: number) {
    return clampWidth(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

function clampRightPanelWidth(width: number, activeView: SidebarView) {
    return clampWidth(
        width,
        getSidebarViewMinimumWidth(activeView),
        MAX_RIGHT_PANEL_WIDTH,
    );
}

function parseStoredJson(key: string): unknown {
    const raw = safeStorageGetItem(key);
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
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

export function readHydratedLayoutSnapshot(): LayoutSnapshot {
    const placement = normalizeMovableSidebarPlacement(
        parseStoredJson(MOVABLE_SIDEBAR_PLACEMENT_KEY),
    );
    const storedActive = parseStoredJson(ACTIVE_SIDEBAR_VIEWS_KEY) as
        Partial<Record<SidebarSide, unknown>> | undefined;
    const leftCandidate =
        storedActive?.left ?? safeStorageGetItem(LEGACY_SIDEBAR_VIEW_KEY);
    const rightCandidate =
        storedActive?.right ?? safeStorageGetItem(LEGACY_RIGHT_PANEL_VIEW_KEY);
    const activeSidebarView: ActiveSidebarViews = {
        left: normalizeActiveSidebarView("left", leftCandidate, placement),
        right: normalizeActiveSidebarView("right", rightCandidate, placement),
    };
    return {
        sidebarCollapsed: safeStorageGetItem(SIDEBAR_COLLAPSED_KEY) === "true",
        sidebarWidth: parseStoredNumber(
            SIDEBAR_WIDTH_KEY,
            DEFAULT_SIDEBAR_WIDTH,
            clampSidebarWidth,
        ),
        activeSidebarView,
        movableSidebarPlacement: placement,
        rightPanelCollapsed:
            safeStorageGetItem(RIGHT_PANEL_COLLAPSED_KEY) === "true",
        rightPanelWidth: parseStoredNumber(
            RIGHT_PANEL_WIDTH_KEY,
            DEFAULT_RIGHT_PANEL_WIDTH,
            (width) => clampRightPanelWidth(width, activeSidebarView.right),
        ),
        editorPaneSizes: (() => {
            const parsed = parseStoredJson(EDITOR_PANE_SIZES_KEY);
            return Array.isArray(parsed)
                ? normalizeEditorPaneSizesForCount(parsed.length, parsed)
                : DEFAULT_EDITOR_PANE_SIZES;
        })(),
    };
}

function persistBoolean(key: string, value: boolean) {
    safeStorageSetItem(key, String(value));
}
function persistNumber(key: string, value: number) {
    safeStorageSetItem(key, String(value));
}
function persistJson(key: string, value: unknown) {
    safeStorageSetItem(key, JSON.stringify(value));
}
function persistEditorPaneSizes(value: number[]) {
    persistJson(EDITOR_PANE_SIZES_KEY, value);
}
function getFileTreeScrollKey(vaultPath: string | null | undefined) {
    return vaultPath || "__no_vault__";
}

export function createDefaultLayoutState(): LayoutSnapshot {
    return {
        sidebarCollapsed: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        activeSidebarView: { left: "files", right: "outline" },
        movableSidebarPlacement: { ...DEFAULT_MOVABLE_SIDEBAR_PLACEMENT },
        rightPanelCollapsed: false,
        rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
        editorPaneSizes: DEFAULT_EDITOR_PANE_SIZES,
    };
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
    ...createDefaultLayoutState(),
    rightPanelExpanded: false,
    fileTreeScrollTopByVault: {},
    activateSidebarView: (side, view) =>
        set((state) => {
            if (
                !isViewAvailableOnSide(
                    view,
                    side,
                    state.movableSidebarPlacement,
                )
            ) {
                return state;
            }
            const activeSidebarView = {
                ...state.activeSidebarView,
                [side]: view,
            };
            persistJson(ACTIVE_SIDEBAR_VIEWS_KEY, activeSidebarView);
            const rightPanelWidth =
                side === "right"
                    ? clampRightPanelWidth(state.rightPanelWidth, view)
                    : state.rightPanelWidth;
            if (rightPanelWidth !== state.rightPanelWidth) {
                persistNumber(RIGHT_PANEL_WIDTH_KEY, rightPanelWidth);
            }
            return {
                activeSidebarView,
                rightPanelWidth,
                rightPanelExpanded: false,
            };
        }),
    showSidebarView: (view) =>
        set((state) => {
            const side = getSidebarViewSide(
                view,
                state.movableSidebarPlacement,
            );
            const activeSidebarView = {
                ...state.activeSidebarView,
                [side]: view,
            };
            persistJson(ACTIVE_SIDEBAR_VIEWS_KEY, activeSidebarView);
            if (side === "left") {
                const sidebarWidth = clampSidebarWidth(state.sidebarWidth);
                persistNumber(SIDEBAR_WIDTH_KEY, sidebarWidth);
                persistBoolean(SIDEBAR_COLLAPSED_KEY, false);
                return {
                    activeSidebarView,
                    sidebarWidth,
                    sidebarCollapsed: false,
                };
            }
            const rightPanelWidth = clampRightPanelWidth(
                state.rightPanelWidth,
                view,
            );
            persistNumber(RIGHT_PANEL_WIDTH_KEY, rightPanelWidth);
            persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, false);
            return {
                activeSidebarView,
                rightPanelWidth,
                rightPanelCollapsed: false,
                rightPanelExpanded: false,
            };
        }),
    moveSidebarView: (view, target) =>
        set((state) => {
            if (!isMovableSidebarView(view)) return state;
            const source = state.movableSidebarPlacement[view];
            if (source === target) return state;
            const movableSidebarPlacement = {
                ...state.movableSidebarPlacement,
                [view]: target,
            };
            const activeSidebarView = {
                ...state.activeSidebarView,
                [target]: view,
            };
            if (state.activeSidebarView[source] === view) {
                activeSidebarView[source] = getSidebarFallbackView(
                    source,
                    movableSidebarPlacement,
                );
            }
            const rightPanelWidth =
                target === "right"
                    ? clampRightPanelWidth(state.rightPanelWidth, view)
                    : state.rightPanelWidth;
            persistJson(MOVABLE_SIDEBAR_PLACEMENT_KEY, movableSidebarPlacement);
            persistJson(ACTIVE_SIDEBAR_VIEWS_KEY, activeSidebarView);
            if (target === "right") {
                persistNumber(RIGHT_PANEL_WIDTH_KEY, rightPanelWidth);
                persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, false);
            } else {
                persistBoolean(SIDEBAR_COLLAPSED_KEY, false);
            }
            return {
                movableSidebarPlacement,
                activeSidebarView,
                sidebarCollapsed:
                    target === "left" ? false : state.sidebarCollapsed,
                rightPanelCollapsed:
                    target === "right" ? false : state.rightPanelCollapsed,
                rightPanelExpanded: false,
                rightPanelWidth,
            };
        }),
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
        const next = clampSidebarWidth(width);
        persistNumber(SIDEBAR_WIDTH_KEY, next);
        set({ sidebarWidth: next });
    },
    showSidebarAtWidth: (width) => {
        const next = clampSidebarWidth(width);
        persistNumber(SIDEBAR_WIDTH_KEY, next);
        persistBoolean(SIDEBAR_COLLAPSED_KEY, false);
        set({ sidebarWidth: next, sidebarCollapsed: false });
    },
    collapseSidebarToWidth: (width) => {
        const next = clampSidebarWidth(width);
        persistNumber(SIDEBAR_WIDTH_KEY, next);
        persistBoolean(SIDEBAR_COLLAPSED_KEY, true);
        set({ sidebarWidth: next, sidebarCollapsed: true });
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
    showRightPanelAtWidth: (width) => {
        const state = get();
        const next = clampRightPanelWidth(width, state.activeSidebarView.right);
        persistNumber(RIGHT_PANEL_WIDTH_KEY, next);
        persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, false);
        set({
            rightPanelWidth: next,
            rightPanelCollapsed: false,
            rightPanelExpanded: false,
        });
    },
    collapseRightPanelToWidth: (width) => {
        const state = get();
        const next = clampRightPanelWidth(width, state.activeSidebarView.right);
        persistNumber(RIGHT_PANEL_WIDTH_KEY, next);
        persistBoolean(RIGHT_PANEL_COLLAPSED_KEY, true);
        set({
            rightPanelWidth: next,
            rightPanelCollapsed: true,
            rightPanelExpanded: false,
        });
    },
    ensureEditorPaneSizeCount: (count) =>
        set((state) => {
            const next = normalizeEditorPaneSizesForCount(
                count,
                state.editorPaneSizes,
            );
            if (
                next.length === state.editorPaneSizes.length &&
                next.every(
                    (value, index) => value === state.editorPaneSizes[index],
                )
            )
                return state;
            persistEditorPaneSizes(next);
            return { editorPaneSizes: next };
        }),
    setEditorPaneSizes: (count, sizes) => {
        const next = normalizeEditorPaneSizesForCount(count, sizes);
        persistEditorPaneSizes(next);
        set({ editorPaneSizes: next });
    },
    getFileTreeScrollTop: (vaultPath) =>
        get().fileTreeScrollTopByVault[getFileTreeScrollKey(vaultPath)] ?? 0,
    setFileTreeScrollTop: (vaultPath, scrollTop) => {
        const key = getFileTreeScrollKey(vaultPath);
        const next = Math.max(0, Math.round(scrollTop));
        set((state) =>
            state.fileTreeScrollTopByVault[key] === next
                ? state
                : {
                      fileTreeScrollTopByVault: {
                          ...state.fileTreeScrollTopByVault,
                          [key]: next,
                      },
                  },
        );
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
