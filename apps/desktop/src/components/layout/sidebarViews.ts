export type SidebarSide = "left" | "right";

export type SidebarView =
    "files" | "agents" | "tags" | "bookmarks" | "maps" | "outline" | "links";

export type MovableSidebarView = "files" | "agents";
export type MovableSidebarPlacement = Record<MovableSidebarView, SidebarSide>;

interface SidebarViewDefinition {
    label: string;
    defaultSide: SidebarSide;
    allowedSides: readonly SidebarSide[];
    order: Record<SidebarSide, number>;
    compact: boolean;
    minimumWidth: number;
}

export const DEFAULT_MOVABLE_SIDEBAR_PLACEMENT: MovableSidebarPlacement = {
    files: "right",
    agents: "left",
};

export const SIDEBAR_VIEW_CATALOG: Record<SidebarView, SidebarViewDefinition> =
    {
        files: {
            label: "Files",
            defaultSide: "left",
            allowedSides: ["left", "right"],
            order: { left: 0, right: 0 },
            compact: false,
            minimumWidth: 280,
        },
        agents: {
            label: "Agents",
            defaultSide: "left",
            allowedSides: ["left", "right"],
            order: { left: 1, right: 1 },
            compact: false,
            minimumWidth: 280,
        },
        tags: {
            label: "Tags",
            defaultSide: "left",
            allowedSides: ["left"],
            order: { left: 2, right: 99 },
            compact: true,
            minimumWidth: 280,
        },
        bookmarks: {
            label: "Bookmarks",
            defaultSide: "left",
            allowedSides: ["left"],
            order: { left: 3, right: 99 },
            compact: true,
            minimumWidth: 280,
        },
        maps: {
            label: "Maps",
            defaultSide: "left",
            allowedSides: ["left"],
            order: { left: 4, right: 99 },
            compact: true,
            minimumWidth: 280,
        },
        outline: {
            label: "Outline",
            defaultSide: "right",
            allowedSides: ["right"],
            order: { left: 99, right: 2 },
            compact: false,
            minimumWidth: 200,
        },
        links: {
            label: "Links",
            defaultSide: "right",
            allowedSides: ["right"],
            order: { left: 99, right: 3 },
            compact: false,
            minimumWidth: 200,
        },
    };

export const MOVABLE_SIDEBAR_VIEWS: readonly MovableSidebarView[] = [
    "files",
    "agents",
];

export function isMovableSidebarView(
    view: SidebarView,
): view is MovableSidebarView {
    return MOVABLE_SIDEBAR_VIEWS.includes(view as MovableSidebarView);
}

export function getSidebarViewSide(
    view: SidebarView,
    placement: MovableSidebarPlacement,
): SidebarSide {
    return isMovableSidebarView(view)
        ? placement[view]
        : SIDEBAR_VIEW_CATALOG[view].defaultSide;
}

export function isViewAvailableOnSide(
    view: SidebarView,
    side: SidebarSide,
    placement: MovableSidebarPlacement,
) {
    return getSidebarViewSide(view, placement) === side;
}

export function getSidebarViews(
    side: SidebarSide,
    placement: MovableSidebarPlacement,
): SidebarView[] {
    return (Object.keys(SIDEBAR_VIEW_CATALOG) as SidebarView[])
        .filter((view) => isViewAvailableOnSide(view, side, placement))
        .sort(
            (left, right) =>
                SIDEBAR_VIEW_CATALOG[left].order[side] -
                SIDEBAR_VIEW_CATALOG[right].order[side],
        );
}

export function getSidebarFallbackView(
    side: SidebarSide,
    placement: MovableSidebarPlacement,
): SidebarView {
    const available = getSidebarViews(side, placement);
    if (side === "right" && available.includes("outline")) return "outline";
    return available[0];
}

export function normalizeActiveSidebarView(
    side: SidebarSide,
    view: unknown,
    placement: MovableSidebarPlacement,
): SidebarView {
    if (
        typeof view === "string" &&
        view in SIDEBAR_VIEW_CATALOG &&
        isViewAvailableOnSide(view as SidebarView, side, placement)
    ) {
        return view as SidebarView;
    }
    return getSidebarFallbackView(side, placement);
}

export function getSidebarViewMinimumWidth(view: SidebarView) {
    return SIDEBAR_VIEW_CATALOG[view].minimumWidth;
}

export function normalizeMovableSidebarPlacement(
    value: unknown,
): MovableSidebarPlacement {
    const record =
        value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
    return {
        files: record.files === "left" ? "left" : "right",
        agents: record.agents === "right" ? "right" : "left",
    };
}
