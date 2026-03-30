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

const preparedCache = new Map<string, PreparedText>();
const invalidationListeners = new Set<() => void>();

let measurementRevision = 0;
let environmentHooksRegistered = false;
let pretextAvailability: boolean | null = null;

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
    const cached = preparedCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const prepared = prepare(text, font.cssFont, { whiteSpace });
    preparedCache.set(cacheKey, prepared);
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
    preparedCache.clear();
    clearPretextCache();
    emitInvalidation();
}

export function clearPretextServiceCacheMatching(
    predicate: (cacheKey: string) => boolean,
) {
    let changed = false;
    for (const key of preparedCache.keys()) {
        if (!predicate(key)) {
            continue;
        }
        preparedCache.delete(key);
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
