import type { CSSProperties } from "react";

// Matches `SidebarFilterInput` (85% bg-tertiary / 70% border) so the
// chrome control group and the filter pill read as a harmonised family
// of sidebar surfaces. The previous mix (`bg-primary 52% / bg-tertiary`)
// collapsed into `bg-secondary` on light themes and barely registered.
export const chromeControlsGroupStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "0 2px",
    borderRadius: 8,
    border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
    background: "color-mix(in srgb, var(--bg-tertiary) 85%, transparent)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
};

export function getChromeIconButtonStyle(active = false): CSSProperties {
    return {
        width: 30,
        height: 30,
        borderRadius: 9,
        border: active
            ? "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))"
            : "1px solid transparent",
        backgroundColor: active
            ? "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))"
            : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        boxShadow: active ? "0 8px 20px rgba(15, 23, 42, 0.08)" : "none",
        opacity: active ? 1 : 0.78,
    };
}

export function getChromeNavigationButtonStyle(
    side: "leading" | "trailing",
    enabled: boolean,
): CSSProperties {
    return {
        width: 22,
        height: 22,
        borderRadius: side === "leading" ? "6px 0 0 6px" : "0 6px 6px 0",
        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
        borderRight: side === "leading" ? "none" : undefined,
        backgroundColor:
            "color-mix(in srgb, var(--bg-primary) 66%, var(--bg-secondary))",
        boxShadow: "none",
        color: "var(--text-secondary)",
        opacity: enabled ? 0.92 : 0.38,
        cursor: enabled ? "pointer" : "default",
    };
}
