import type { CSSProperties } from "react";

export const chromeControlsGroupStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 3px",
    borderRadius: 12,
    border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
    background: "color-mix(in srgb, var(--bg-primary) 52%, var(--bg-tertiary))",
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
        width: 30,
        height: 30,
        borderRadius: side === "leading" ? "9px 0 0 9px" : "0 9px 9px 0",
        border: "1px solid var(--border)",
        borderRight: side === "leading" ? "none" : undefined,
        backgroundColor: "var(--bg-secondary)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
        color: "var(--text-secondary)",
        opacity: enabled ? 0.85 : 0.35,
        cursor: enabled ? "pointer" : "default",
    };
}
