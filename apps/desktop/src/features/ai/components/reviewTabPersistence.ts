import type { ReviewFileItem } from "../diff/editedFilesPresentationModel";
import type { ReviewHunkId } from "../diff/reviewProjection";

const REVIEW_VIEW_STATE_VERSION = 1;
const REVIEW_VIEW_STATE_PREFIX = "vaultai.ai.review.view";
const REVIEW_VIEW_GLOBAL_SCOPE = "__global__";

interface PersistedReviewHunkLineSpan {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

export interface PersistedReviewAnchor {
    identityKey: string;
    trackedVersion: number;
    hunkKeys: string[];
    pathAliases?: string[];
    hunkLineSpans?: PersistedReviewHunkLineSpan[];
}

export interface PersistedReviewViewState {
    version: number;
    expandedIdentityKeys: string[];
    scrollTop: number;
    anchor: PersistedReviewAnchor | null;
    writerId?: string;
    updatedAt: number;
}

function getReviewViewStateKey(vaultPath: string, sessionId: string) {
    return `${REVIEW_VIEW_STATE_PREFIX}:${vaultPath}:${sessionId}`;
}

function getReviewViewScope(vaultPath: string | null) {
    return vaultPath ?? REVIEW_VIEW_GLOBAL_SCOPE;
}

export function getReviewViewStorageKey(
    vaultPath: string | null,
    sessionId: string,
) {
    return getReviewViewStateKey(getReviewViewScope(vaultPath), sessionId);
}

function normalizePathAlias(path: string) {
    return path.replace(/\\/g, "/");
}

function normalizePathAliases(paths: Iterable<string>) {
    const normalized = new Set<string>();
    for (const path of paths) {
        if (typeof path !== "string" || path.length === 0) {
            continue;
        }
        normalized.add(normalizePathAlias(path));
    }
    return [...normalized];
}

function parseHunkKeyToLineSpan(
    key: string,
): PersistedReviewHunkLineSpan | null {
    const match = /^(\d+):(\d+):(\d+):(\d+)$/.exec(key);
    if (!match) {
        return null;
    }
    return {
        oldStart: Number(match[1]),
        oldEnd: Number(match[2]),
        newStart: Number(match[3]),
        newEnd: Number(match[4]),
    };
}

function areEquivalentLineSpans(
    left: PersistedReviewHunkLineSpan,
    right: PersistedReviewHunkLineSpan,
) {
    const oldLenLeft = left.oldEnd - left.oldStart;
    const oldLenRight = right.oldEnd - right.oldStart;
    const newLenLeft = left.newEnd - left.newStart;
    const newLenRight = right.newEnd - right.newStart;
    if (oldLenLeft !== oldLenRight || newLenLeft !== newLenRight) {
        return false;
    }

    // Tolerate end-of-document newline normalization drift (±1 line shift).
    const withinTolerance = (a: number, b: number) => Math.abs(a - b) <= 1;
    return (
        withinTolerance(left.oldStart, right.oldStart) &&
        withinTolerance(left.oldEnd, right.oldEnd) &&
        withinTolerance(left.newStart, right.newStart) &&
        withinTolerance(left.newEnd, right.newEnd)
    );
}

function normalizeAnchor(
    raw: unknown,
): PersistedReviewViewState["anchor"] | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const identityKey = (raw as { identityKey?: unknown }).identityKey;
    const trackedVersion = (raw as { trackedVersion?: unknown }).trackedVersion;
    const hunkKeys = (raw as { hunkKeys?: unknown }).hunkKeys;
    const pathAliases = (raw as { pathAliases?: unknown }).pathAliases;
    const hunkLineSpans = (raw as { hunkLineSpans?: unknown }).hunkLineSpans;

    if (
        typeof identityKey !== "string" ||
        typeof trackedVersion !== "number" ||
        !Number.isFinite(trackedVersion) ||
        !Array.isArray(hunkKeys)
    ) {
        return null;
    }

    return {
        identityKey,
        trackedVersion,
        hunkKeys: hunkKeys.filter(
            (entry): entry is string => typeof entry === "string",
        ),
        pathAliases: Array.isArray(pathAliases)
            ? normalizePathAliases(
                  pathAliases.filter(
                      (entry): entry is string => typeof entry === "string",
                  ),
              )
            : undefined,
        hunkLineSpans: Array.isArray(hunkLineSpans)
            ? hunkLineSpans
                  .map((entry) => {
                      if (!entry || typeof entry !== "object") {
                          return null;
                      }
                      const oldStart = (entry as { oldStart?: unknown })
                          .oldStart;
                      const oldEnd = (entry as { oldEnd?: unknown }).oldEnd;
                      const newStart = (entry as { newStart?: unknown })
                          .newStart;
                      const newEnd = (entry as { newEnd?: unknown }).newEnd;
                      if (
                          typeof oldStart !== "number" ||
                          typeof oldEnd !== "number" ||
                          typeof newStart !== "number" ||
                          typeof newEnd !== "number"
                      ) {
                          return null;
                      }
                      return {
                          oldStart,
                          oldEnd,
                          newStart,
                          newEnd,
                      };
                  })
                  .filter(
                      (span): span is PersistedReviewHunkLineSpan =>
                          span !== null,
                  )
            : undefined,
    };
}

function normalizePersistedState(
    raw: unknown,
): PersistedReviewViewState | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const version = (raw as { version?: unknown }).version;
    const expandedIdentityKeys = (raw as { expandedIdentityKeys?: unknown })
        .expandedIdentityKeys;
    const scrollTop = (raw as { scrollTop?: unknown }).scrollTop;
    const writerId = (raw as { writerId?: unknown }).writerId;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;

    if (
        version !== REVIEW_VIEW_STATE_VERSION ||
        !Array.isArray(expandedIdentityKeys) ||
        typeof scrollTop !== "number" ||
        !Number.isFinite(scrollTop) ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    return {
        version,
        expandedIdentityKeys: expandedIdentityKeys.filter(
            (entry): entry is string => typeof entry === "string",
        ),
        scrollTop: Math.max(0, scrollTop),
        anchor: normalizeAnchor((raw as { anchor?: unknown }).anchor),
        writerId: typeof writerId === "string" ? writerId : undefined,
        updatedAt,
    };
}

export function readPersistedReviewViewState(
    vaultPath: string | null,
    sessionId: string,
): PersistedReviewViewState | null {
    try {
        const raw = localStorage.getItem(
            getReviewViewStateKey(getReviewViewScope(vaultPath), sessionId),
        );
        if (!raw) {
            return null;
        }
        return normalizePersistedState(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function persistReviewViewState(
    vaultPath: string | null,
    sessionId: string,
    next: {
        expandedIdentityKeys: Iterable<string>;
        scrollTop: number;
        anchor: PersistedReviewAnchor | null;
    },
    options?: {
        baseUpdatedAt?: number | null;
        writerId?: string;
    },
) {
    const existing = readPersistedReviewViewState(vaultPath, sessionId);
    const nextExpandedIdentityKeys = [...next.expandedIdentityKeys];
    const requested: PersistedReviewViewState = {
        version: REVIEW_VIEW_STATE_VERSION,
        expandedIdentityKeys: nextExpandedIdentityKeys,
        scrollTop: Math.max(
            0,
            Number.isFinite(next.scrollTop) ? next.scrollTop : 0,
        ),
        anchor: next.anchor,
        writerId: options?.writerId,
        updatedAt: Date.now(),
    };
    const staleWriteDetected =
        existing &&
        typeof options?.baseUpdatedAt === "number" &&
        existing.updatedAt > options.baseUpdatedAt;

    const payload: PersistedReviewViewState =
        staleWriteDetected && existing
            ? {
                  ...requested,
                  expandedIdentityKeys: [
                      ...new Set([
                          ...existing.expandedIdentityKeys,
                          ...nextExpandedIdentityKeys,
                      ]),
                  ],
                  scrollTop: existing.scrollTop,
                  anchor: existing.anchor,
              }
            : requested;

    try {
        localStorage.setItem(
            getReviewViewStateKey(getReviewViewScope(vaultPath), sessionId),
            JSON.stringify(payload),
        );
    } catch {
        // Ignore localStorage errors (quota, private mode, etc)
    }

    return payload;
}

function getItemPathAliases(item: ReviewFileItem) {
    return normalizePathAliases([
        item.file.identityKey,
        item.file.path,
        item.file.originPath,
        item.file.previousPath ?? "",
    ]);
}

export function createPersistedReviewAnchor(
    file: {
        identityKey: string;
        path: string;
        originPath: string;
        previousPath: string | null;
    },
    trackedVersion: number,
    hunkIds: ReviewHunkId[],
): PersistedReviewAnchor {
    return {
        identityKey: file.identityKey,
        trackedVersion,
        hunkKeys: hunkIds.map((hunkId) => hunkId.key),
        pathAliases: normalizePathAliases([
            file.identityKey,
            file.path,
            file.originPath,
            file.previousPath ?? "",
        ]),
        hunkLineSpans: hunkIds
            .map((hunkId) => parseHunkKeyToLineSpan(hunkId.key))
            .filter(
                (span): span is PersistedReviewHunkLineSpan => span !== null,
            ),
    };
}

export function resolvePersistedReviewAnchor(
    anchor: PersistedReviewAnchor | null,
    items: ReviewFileItem[],
): PersistedReviewAnchor | null {
    if (!anchor) {
        return null;
    }

    const anchorPathAliasSet = new Set(
        normalizePathAliases([
            anchor.identityKey,
            ...(anchor.pathAliases ?? []),
        ]),
    );
    const item = items.find((entry) => {
        if (entry.file.identityKey === anchor.identityKey) {
            return true;
        }
        const aliases = getItemPathAliases(entry);
        return aliases.some((alias) => anchorPathAliasSet.has(alias));
    });
    if (!item) {
        return null;
    }

    if (item.reviewProjection.trackedVersion !== anchor.trackedVersion) {
        return null;
    }

    const projectionHunks = item.reviewProjection.hunks;
    const hunkKeySet = new Set(projectionHunks.map((hunk) => hunk.id.key));
    const exactMatch = anchor.hunkKeys.every((hunkKey) =>
        hunkKeySet.has(hunkKey),
    );
    if (exactMatch) {
        return {
            ...anchor,
            identityKey: item.file.identityKey,
            pathAliases: getItemPathAliases(item),
        };
    }

    if (!anchor.hunkLineSpans || anchor.hunkLineSpans.length === 0) {
        return null;
    }

    const projectionSpanByKey = new Map<string, PersistedReviewHunkLineSpan>();
    for (const hunk of projectionHunks) {
        const parsed = parseHunkKeyToLineSpan(hunk.id.key);
        if (parsed) {
            projectionSpanByKey.set(hunk.id.key, parsed);
        }
    }

    const tolerantMatchedKeys: string[] = [];
    for (const anchorSpan of anchor.hunkLineSpans) {
        const matched = [...projectionSpanByKey.entries()].find(([, span]) =>
            areEquivalentLineSpans(anchorSpan, span),
        );
        if (!matched) {
            return null;
        }
        tolerantMatchedKeys.push(matched[0]);
    }

    if (tolerantMatchedKeys.length === 0) {
        return null;
    }

    return {
        ...anchor,
        identityKey: item.file.identityKey,
        hunkKeys: [...new Set(tolerantMatchedKeys)],
        pathAliases: getItemPathAliases(item),
    };
}
