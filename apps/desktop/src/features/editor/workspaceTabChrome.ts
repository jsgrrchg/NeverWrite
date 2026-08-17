import type { CSSProperties } from "react";

export const WORKSPACE_TAB_BAR_HEIGHT = 33;
export const WORKSPACE_TAB_HEIGHT = 26;
export const WORKSPACE_TAB_RADIUS = 8;
export const WORKSPACE_PINNED_TAB_SIZE = 28;

const ACTIVE_TAB_BORDER =
    "1px solid color-mix(in srgb, var(--accent) 34%, var(--border))";
const IDLE_TAB_BORDER = "1px solid transparent";
const ACTIVE_TAB_BACKGROUND =
    "color-mix(in srgb, var(--bg-primary) 92%, var(--accent) 8%)";
const ACTIVE_TAB_SHADOW = [
    "inset 0 1px 0 color-mix(in srgb, var(--text-primary) 8%, transparent)",
    "0 1px 2px rgba(0, 0, 0, 0.18)",
].join(", ");

export function getWorkspaceTabBarStyle(): CSSProperties {
    return {
        height: WORKSPACE_TAB_BAR_HEIGHT,
        minHeight: WORKSPACE_TAB_BAR_HEIGHT,
        boxSizing: "border-box",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-secondary)",
    };
}

export function getWorkspaceTabStyle({
    isActive,
    isDragging,
    isPinned = false,
    tabWidth,
    tabGap,
    tabPaddingX,
    draggingOpacity = 0.38,
}: {
    isActive: boolean;
    isDragging: boolean;
    isPinned?: boolean;
    tabWidth: number;
    tabGap: number;
    tabPaddingX: number;
    draggingOpacity?: number;
}): CSSProperties {
    const width = isPinned ? WORKSPACE_PINNED_TAB_SIZE : tabWidth;

    return {
        width,
        minWidth: width,
        maxWidth: isPinned ? WORKSPACE_PINNED_TAB_SIZE : 240,
        height: WORKSPACE_TAB_HEIGHT,
        flexShrink: 0,
        alignSelf: "center",
        justifyContent: isPinned ? "center" : undefined,
        boxSizing: "border-box",
        gap: isPinned ? 0 : tabGap,
        padding: isPinned ? 0 : `0 ${tabPaddingX}px`,
        borderRadius: WORKSPACE_TAB_RADIUS,
        border: isActive ? ACTIVE_TAB_BORDER : IDLE_TAB_BORDER,
        background: isActive ? ACTIVE_TAB_BACKGROUND : "transparent",
        color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
        boxShadow: isActive ? ACTIVE_TAB_SHADOW : "none",
        letterSpacing: "-0.012em",
        zIndex: isActive ? 10 : 0,
        opacity: isDragging ? draggingOpacity : 1,
        cursor: isDragging ? "grabbing" : "pointer",
        transition:
            "background 160ms ease, color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, opacity 120ms ease",
    };
}

export function getWorkspaceTabCloseButtonStyle({
    size,
}: {
    size: number;
}): CSSProperties {
    return {
        width: size,
        height: size,
        borderRadius: 999,
        color: "var(--text-secondary)",
        marginRight: -2,
    };
}

export function getWorkspaceTabDragPreviewStyle({
    tabGap,
    tabPaddingX,
    maxWidth = 288,
}: {
    tabGap: number;
    tabPaddingX: number;
    maxWidth?: number;
}): CSSProperties {
    return {
        position: "fixed",
        left: 0,
        top: 0,
        display: "flex",
        alignItems: "center",
        gap: tabGap,
        maxWidth,
        height: WORKSPACE_TAB_HEIGHT,
        padding: `0 ${tabPaddingX}px`,
        borderRadius: WORKSPACE_TAB_RADIUS,
        border: "1px solid var(--border)",
        background: "var(--bg-secondary)",
        color: "var(--text-primary)",
        boxShadow: "0 8px 18px rgba(0, 0, 0, 0.28)",
        letterSpacing: "-0.012em",
        pointerEvents: "none",
        zIndex: 9999,
        willChange: "transform",
    };
}

export function getWorkspaceTabInsertionIndicatorStyle(): CSSProperties {
    return {
        position: "absolute",
        top: "50%",
        left: 0,
        width: 2,
        height: 18,
        borderRadius: 999,
        backgroundColor: "var(--accent)",
        boxShadow:
            "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
        pointerEvents: "none",
        zIndex: 20,
        display: "none",
    };
}
