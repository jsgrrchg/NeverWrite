export function getDangerButtonStyle(disabled = false): React.CSSProperties {
    return {
        color: disabled
            ? "var(--text-secondary)"
            : "color-mix(in srgb, var(--text-primary) 72%, var(--diff-remove))",
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 8%, var(--bg-secondary))",
        border: "1px solid color-mix(in srgb, var(--diff-remove) 28%, var(--border))",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
    };
}

export function getAccentButtonStyle(
    accent = "var(--accent)",
): React.CSSProperties {
    return {
        color: accent,
        backgroundColor:
            "color-mix(in srgb, var(--bg-secondary) 92%, transparent)",
        border: `1px solid color-mix(in srgb, ${accent} 55%, var(--border))`,
    };
}

export function getNeutralButtonStyle(): React.CSSProperties {
    return {
        color: "var(--text-secondary)",
        backgroundColor:
            "color-mix(in srgb, var(--bg-secondary) 74%, transparent)",
        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
    };
}

/* ---------- Shared review-view visual tokens ---------- */

/** Stat chip used in the review header for files / additions / deletions / conflicts */
export function getStatChipStyle(
    color = "var(--text-secondary)",
): React.CSSProperties {
    return {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: "0.75em",
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        color,
        backgroundColor: `color-mix(in srgb, ${color} 8%, var(--bg-secondary))`,
        border: `1px solid color-mix(in srgb, ${color} 15%, var(--border))`,
    };
}

/** Thin left-side accent bar for file cards based on change tone */
export function getToneBorderStyle(accent: string): React.CSSProperties {
    return {
        borderLeft: `3px solid color-mix(in srgb, ${accent} 55%, transparent)`,
    };
}
