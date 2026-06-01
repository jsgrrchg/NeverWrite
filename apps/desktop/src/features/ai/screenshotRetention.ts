import { normalizeComposerParts } from "./composerParts";
import type { AIComposerPart } from "./types";

export const SCREENSHOT_RETENTION_OPTIONS = [
    { value: 60, label: "1 minute" },
    { value: 300, label: "5 minutes" },
    { value: 1800, label: "30 minutes" },
    { value: 3600, label: "1 hour" },
    { value: 86400, label: "24 hours" },
    { value: 604800, label: "7 days" },
    { value: 0, label: "Forever" },
] as const;

export const DEFAULT_SCREENSHOT_RETENTION_SECONDS = 1800;

const FINITE_SCREENSHOT_RETENTION_SECONDS = SCREENSHOT_RETENTION_OPTIONS.map(
    (option) => option.value,
).filter((value) => value > 0);

const SCREENSHOT_RETENTION_VALUES: Set<number> = new Set(
    SCREENSHOT_RETENTION_OPTIONS.map((option) => option.value),
);

export function normalizeScreenshotRetentionSeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SCREENSHOT_RETENTION_SECONDS;
    }

    if (value === 0) return 0;

    const rounded = Math.round(value);
    if (rounded <= 0) return DEFAULT_SCREENSHOT_RETENTION_SECONDS;

    if (SCREENSHOT_RETENTION_VALUES.has(rounded)) return rounded;

    return (
        FINITE_SCREENSHOT_RETENTION_SECONDS.find(
            (candidate) => candidate >= rounded,
        ) ??
        FINITE_SCREENSHOT_RETENTION_SECONDS.at(-1) ??
        DEFAULT_SCREENSHOT_RETENTION_SECONDS
    );
}

function getScreenshotCreatedAt(
    part: Extract<AIComposerPart, { type: "screenshot" }>,
) {
    return typeof part.createdAt === "number" && Number.isFinite(part.createdAt)
        ? part.createdAt
        : null;
}

export function normalizeScreenshotPartTimestamps(
    parts: AIComposerPart[],
    now = Date.now(),
): AIComposerPart[] {
    let changed = false;
    const normalized = parts.map((part) => {
        if (part.type !== "screenshot") return part;
        if (getScreenshotCreatedAt(part) != null) return part;
        changed = true;
        return { ...part, createdAt: now };
    });

    return changed ? normalized : parts;
}

export function pruneExpiredScreenshotParts(
    parts: AIComposerPart[],
    retentionSeconds: number,
    now = Date.now(),
): AIComposerPart[] {
    if (retentionSeconds <= 0) return parts;

    const retentionMs = retentionSeconds * 1000;
    let changed = false;
    const next = parts.filter((part) => {
        if (part.type !== "screenshot") return true;
        const createdAt = getScreenshotCreatedAt(part);
        if (createdAt == null || now - createdAt < retentionMs) return true;
        changed = true;
        return false;
    });

    return changed ? normalizeComposerParts(next) : parts;
}

export function getNextScreenshotExpiryDelayMs(
    parts: AIComposerPart[],
    retentionSeconds: number,
    now = Date.now(),
): number | null {
    if (retentionSeconds <= 0) return null;

    const retentionMs = retentionSeconds * 1000;
    let nextDelay: number | null = null;

    for (const part of parts) {
        if (part.type !== "screenshot") continue;
        const createdAt = getScreenshotCreatedAt(part);
        if (createdAt == null) return 0;
        const delay = Math.max(0, createdAt + retentionMs - now);
        nextDelay = nextDelay == null ? delay : Math.min(nextDelay, delay);
    }

    return nextDelay;
}
