/**
 * OKF (Open Knowledge Format) document status.
 *
 * NeverWrite defines a `status` extension field in OKF frontmatter to signal
 * a document's publication/trust state. OKF is permissive on consumption:
 * unknown status values are normalized and shown, never rejected.
 *
 * This module is shared between the editor header and the file tree, so the
 * public API here is intentionally stable.
 */

export const KNOWN_STATUSES = [
    "draft",
    "in_review",
    "published",
    "deprecated",
    "archived",
] as const;

export type KnownDocumentStatus = (typeof KNOWN_STATUSES)[number];

export type StatusTone = "muted" | "accent" | "success" | "warning";

/**
 * Normalize a raw frontmatter status value.
 *
 * - Non-string or empty/whitespace-only input returns `null`.
 * - Otherwise the value is trimmed, lowercased, and any run of spaces or
 *   hyphens is collapsed to a single underscore.
 * - The alias `"review"` maps to `"in_review"`.
 *
 * Unknown values are still returned (normalized) rather than dropped, so the
 * UI can surface them verbatim.
 */
export function normalizeDocumentStatus(raw: unknown): string | null {
    if (typeof raw !== "string") return null;

    const trimmed = raw.trim();
    if (!trimmed) return null;

    const normalized = trimmed
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    if (!normalized) return null;
    if (normalized === "review") return "in_review";

    return normalized;
}

export function isKnownStatus(s: string): s is KnownDocumentStatus {
    return (KNOWN_STATUSES as readonly string[]).includes(s);
}

const STATUS_LABELS: Record<KnownDocumentStatus, string> = {
    draft: "Draft",
    in_review: "In review",
    published: "Published",
    deprecated: "Deprecated",
    archived: "Archived",
};

/**
 * Human-readable label for a normalized status. Known statuses use a fixed
 * label; unknown statuses render their normalized value with underscores
 * turned back into spaces.
 */
export function statusLabel(s: string): string {
    if (isKnownStatus(s)) return STATUS_LABELS[s];
    return s.replace(/_/g, " ");
}

const STATUS_TONES: Record<KnownDocumentStatus, StatusTone> = {
    draft: "muted",
    in_review: "accent",
    published: "success",
    deprecated: "warning",
    archived: "muted",
};

/** Badge tone for a normalized status. Unknown statuses fall back to muted. */
export function statusTone(s: string): StatusTone {
    if (isKnownStatus(s)) return STATUS_TONES[s];
    return "muted";
}

/**
 * CSS color for the leading status dot. Uses the app's CSS variables and the
 * `color-mix` idiom so it reads correctly in both light and dark themes.
 */
export function statusDotColor(s: string): string {
    switch (s) {
        case "published":
            // Green, matching the success badge palette.
            return "#22c55e";
        case "in_review":
            return "var(--accent)";
        case "draft":
            // Amber.
            return "#f59e0b";
        case "deprecated":
            // Orange.
            return "#f97316";
        case "archived":
            return "var(--text-secondary)";
        default:
            return "var(--text-secondary)";
    }
}
