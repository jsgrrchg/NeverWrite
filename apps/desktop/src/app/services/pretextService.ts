import {
    clearCache as clearPretextCache,
    layout,
    prepare,
    type PreparedText,
} from "@chenglou/pretext";
import type { PretextFontSignature } from "../utils/pretextFontSignatures";

type PretextWhiteSpaceMode = "normal" | "pre-wrap";

interface MeasurePretextTextOptions {
    text: string;
    maxWidth: number;
    font: PretextFontSignature;
    lineHeightPx?: number;
    whiteSpace?: PretextWhiteSpaceMode;
    cacheScope?: string;
}

interface MeasurePretextTextResult {
    height: number;
    lineCount: number;
    usedPretext: boolean;
}

interface PreparedCachePolicy {
    persistPreparedText: boolean;
    maxEntries: number;
    maxEstimatedBytes: number;
}

interface PreparedCacheEntry {
    prepared: PreparedText;
    cacheScope: string;
    estimatedBytes: number;
}

interface PreparedTextCacheShape {
    widths?: number[];
    lineEndFitAdvances?: number[];
    lineEndPaintAdvances?: number[];
    kinds?: unknown[];
    segLevels?: Int8Array | null;
    breakableWidths?: (number[] | null)[];
    breakablePrefixWidths?: (number[] | null)[];
    chunks?: Array<unknown>;
}

const KB = 1024;
const MB = KB * KB;
const PREPARED_CACHE_GLOBAL_LIMITS = {
    maxEntries: 160,
    maxEstimatedBytes: 6 * MB,
} as const;
const DEFAULT_PREPARED_CACHE_POLICY: PreparedCachePolicy = {
    persistPreparedText: true,
    maxEntries: 96,
    maxEstimatedBytes: 3 * MB,
};
const PREPARED_CACHE_POLICIES: Readonly<Record<string, PreparedCachePolicy>> = {
    // Composer drafts change almost every keystroke, so persisting prepared
    // snapshots here creates a high-cardinality cache with poor reuse.
    "composer-text": {
        persistPreparedText: false,
        maxEntries: 0,
        maxEstimatedBytes: 0,
    },
    "user-text": {
        persistPreparedText: true,
        maxEntries: 64,
        maxEstimatedBytes: 2 * MB,
    },
    "markdown-paragraph": {
        persistPreparedText: true,
        maxEntries: 72,
        maxEstimatedBytes: 2 * MB,
    },
    "markdown-heading": {
        persistPreparedText: true,
        maxEntries: 24,
        maxEstimatedBytes: 384 * KB,
    },
    "markdown-code": {
        persistPreparedText: true,
        maxEntries: 32,
        maxEstimatedBytes: 1 * MB,
    },
};

const preparedCache = new Map<string, PreparedCacheEntry>();
const preparedCacheEntryCountByScope = new Map<string, number>();
const preparedCacheEstimatedBytesByScope = new Map<string, number>();
const invalidationListeners = new Set<() => void>();

let measurementRevision = 0;
let environmentHooksRegistered = false;
let pretextAvailability: boolean | null = null;
let preparedCacheEstimatedBytes = 0;

function emitInvalidation() {
    measurementRevision += 1;
    invalidationListeners.forEach((listener) => listener());
}

function ensureEnvironmentHooks() {
    if (environmentHooksRegistered || typeof document === "undefined") {
        return;
    }

    environmentHooksRegistered = true;

    const fontSet = document.fonts;
    if (!fontSet) {
        return;
    }

    const invalidateForFonts = () => {
        clearPretextServiceCache();
    };

    if (typeof fontSet.addEventListener === "function") {
        fontSet.addEventListener("loadingdone", invalidateForFonts);
        fontSet.addEventListener("loadingerror", invalidateForFonts);
    }

    void fontSet.ready.then(() => {
        clearPretextServiceCache();
    });
}

function canUsePretext() {
    if (pretextAvailability !== null) {
        return pretextAvailability;
    }

    if (
        typeof document === "undefined" ||
        typeof HTMLCanvasElement === "undefined"
    ) {
        pretextAvailability = false;
        return pretextAvailability;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes("jsdom")) {
        pretextAvailability = false;
        return pretextAvailability;
    }

    pretextAvailability = true;
    return pretextAvailability;
}

function buildPreparedCacheKey(options: {
    text: string;
    font: PretextFontSignature;
    whiteSpace: PretextWhiteSpaceMode;
    cacheScope: string;
}) {
    return [
        options.cacheScope,
        options.whiteSpace,
        options.font.key,
        options.text,
    ].join("\u0001");
}

function getPreparedCachePolicy(cacheScope: string): PreparedCachePolicy {
    return PREPARED_CACHE_POLICIES[cacheScope] ?? DEFAULT_PREPARED_CACHE_POLICY;
}

function bumpPreparedCacheScopeMetric(
    metrics: Map<string, number>,
    cacheScope: string,
    delta: number,
) {
    if (delta === 0) {
        return;
    }

    const nextValue = (metrics.get(cacheScope) ?? 0) + delta;
    if (nextValue <= 0) {
        metrics.delete(cacheScope);
        return;
    }
    metrics.set(cacheScope, nextValue);
}

function rememberPreparedCacheEntry(
    cacheKey: string,
    entry: PreparedCacheEntry,
) {
    preparedCache.set(cacheKey, entry);
    preparedCacheEstimatedBytes += entry.estimatedBytes;
    bumpPreparedCacheScopeMetric(
        preparedCacheEntryCountByScope,
        entry.cacheScope,
        1,
    );
    bumpPreparedCacheScopeMetric(
        preparedCacheEstimatedBytesByScope,
        entry.cacheScope,
        entry.estimatedBytes,
    );
}

function forgetPreparedCacheEntry(cacheKey: string, entry: PreparedCacheEntry) {
    if (!preparedCache.delete(cacheKey)) {
        return;
    }

    preparedCacheEstimatedBytes = Math.max(
        0,
        preparedCacheEstimatedBytes - entry.estimatedBytes,
    );
    bumpPreparedCacheScopeMetric(
        preparedCacheEntryCountByScope,
        entry.cacheScope,
        -1,
    );
    bumpPreparedCacheScopeMetric(
        preparedCacheEstimatedBytesByScope,
        entry.cacheScope,
        -entry.estimatedBytes,
    );
}

function clearPreparedCacheState() {
    preparedCache.clear();
    preparedCacheEntryCountByScope.clear();
    preparedCacheEstimatedBytesByScope.clear();
    preparedCacheEstimatedBytes = 0;
}

function estimatePreparedTextBytes(
    cacheKey: string,
    prepared: PreparedText,
): number {
    const shapedPrepared = prepared as PreparedText & PreparedTextCacheShape;
    let estimatedBytes = 256 + cacheKey.length * 2;

    const widthsLength = shapedPrepared.widths?.length ?? 0;
    estimatedBytes += widthsLength * 8;
    estimatedBytes += (shapedPrepared.lineEndFitAdvances?.length ?? 0) * 8;
    estimatedBytes += (shapedPrepared.lineEndPaintAdvances?.length ?? 0) * 8;
    estimatedBytes += (shapedPrepared.kinds?.length ?? 0) * 8;
    estimatedBytes += shapedPrepared.segLevels?.byteLength ?? 0;
    estimatedBytes += (shapedPrepared.breakableWidths?.length ?? 0) * 8;
    estimatedBytes += (shapedPrepared.breakablePrefixWidths?.length ?? 0) * 8;
    estimatedBytes += (shapedPrepared.chunks?.length ?? 0) * 24;

    for (const breakableWidths of shapedPrepared.breakableWidths ?? []) {
        estimatedBytes += (breakableWidths?.length ?? 0) * 8;
    }
    for (const prefixWidths of shapedPrepared.breakablePrefixWidths ?? []) {
        estimatedBytes += (prefixWidths?.length ?? 0) * 8;
    }

    return estimatedBytes;
}

function evictOldestPreparedCacheEntry(
    predicate: (entry: PreparedCacheEntry) => boolean,
) {
    for (const [cacheKey, entry] of preparedCache.entries()) {
        if (!predicate(entry)) {
            continue;
        }
        forgetPreparedCacheEntry(cacheKey, entry);
        return true;
    }
    return false;
}

function enforcePreparedCacheLimits(cacheScope: string) {
    const policy = getPreparedCachePolicy(cacheScope);

    while (
        (preparedCacheEntryCountByScope.get(cacheScope) ?? 0) >
            policy.maxEntries ||
        (preparedCacheEstimatedBytesByScope.get(cacheScope) ?? 0) >
            policy.maxEstimatedBytes
    ) {
        if (
            !evictOldestPreparedCacheEntry(
                (entry) => entry.cacheScope === cacheScope,
            )
        ) {
            break;
        }
    }

    while (
        preparedCache.size > PREPARED_CACHE_GLOBAL_LIMITS.maxEntries ||
        preparedCacheEstimatedBytes >
            PREPARED_CACHE_GLOBAL_LIMITS.maxEstimatedBytes
    ) {
        if (!evictOldestPreparedCacheEntry(() => true)) {
            break;
        }
    }
}

function getOrPrepareText(
    text: string,
    font: PretextFontSignature,
    whiteSpace: PretextWhiteSpaceMode,
    cacheScope: string,
) {
    const cacheKey = buildPreparedCacheKey({
        text,
        font,
        whiteSpace,
        cacheScope,
    });
    const cachePolicy = getPreparedCachePolicy(cacheScope);
    if (cachePolicy.persistPreparedText) {
        const cached = preparedCache.get(cacheKey);
        if (cached) {
            forgetPreparedCacheEntry(cacheKey, cached);
            rememberPreparedCacheEntry(cacheKey, cached);
            return cached.prepared;
        }
    }

    const prepared = prepare(text, font.cssFont, { whiteSpace });
    if (!cachePolicy.persistPreparedText) {
        return prepared;
    }

    rememberPreparedCacheEntry(cacheKey, {
        prepared,
        cacheScope,
        estimatedBytes: estimatePreparedTextBytes(cacheKey, prepared),
    });
    enforcePreparedCacheLimits(cacheScope);
    return prepared;
}

export function getPretextMeasurementRevision() {
    ensureEnvironmentHooks();
    return measurementRevision;
}

export function subscribePretextInvalidation(listener: () => void) {
    ensureEnvironmentHooks();
    invalidationListeners.add(listener);
    return () => {
        invalidationListeners.delete(listener);
    };
}

export function clearPretextServiceCache() {
    clearPreparedCacheState();
    clearPretextCache();
    emitInvalidation();
}

export function clearPretextServiceCacheMatching(
    predicate: (cacheKey: string) => boolean,
) {
    let changed = false;
    for (const [key, entry] of preparedCache.entries()) {
        if (!predicate(key)) {
            continue;
        }
        forgetPreparedCacheEntry(key, entry);
        changed = true;
    }

    if (changed) {
        clearPretextCache();
        emitInvalidation();
    }
}

export function invalidatePretextEnvironment() {
    clearPretextServiceCache();
}

export function measurePretextText(
    options: MeasurePretextTextOptions,
): MeasurePretextTextResult | null {
    ensureEnvironmentHooks();

    if (
        !canUsePretext() ||
        !Number.isFinite(options.maxWidth) ||
        options.maxWidth <= 0
    ) {
        return null;
    }

    const whiteSpace = options.whiteSpace ?? "normal";
    const cacheScope = options.cacheScope ?? "text";

    try {
        const prepared = getOrPrepareText(
            options.text,
            options.font,
            whiteSpace,
            cacheScope,
        );
        const result = layout(
            prepared,
            options.maxWidth,
            options.lineHeightPx ?? options.font.lineHeightPx,
        );

        return {
            ...result,
            usedPretext: true,
        };
    } catch {
        pretextAvailability = false;
        return null;
    }
}
