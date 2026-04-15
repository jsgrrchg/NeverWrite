import {
    safeStorageGetItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "./safeStorage";

export const APP_ZOOM_STORAGE_KEY = "neverwrite:appZoom";
export const DEFAULT_APP_ZOOM = 1;
export const MIN_APP_ZOOM = 0.8;
export const MAX_APP_ZOOM = 2;
export const APP_ZOOM_STEP = 0.1;

export function normalizeAppZoom(value: unknown): number {
    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number(value)
              : NaN;

    if (!Number.isFinite(parsed)) {
        return DEFAULT_APP_ZOOM;
    }

    return Number(
        Math.min(MAX_APP_ZOOM, Math.max(MIN_APP_ZOOM, parsed)).toFixed(2),
    );
}

export function readAppZoom() {
    return normalizeAppZoom(safeStorageGetItem(APP_ZOOM_STORAGE_KEY));
}

export function writeAppZoom(zoom: number) {
    const normalized = normalizeAppZoom(zoom);
    safeStorageSetItem(APP_ZOOM_STORAGE_KEY, String(normalized));
    return normalized;
}

export function stepAppZoom(
    currentZoom: number,
    direction: "in" | "out",
): number {
    const delta = direction === "in" ? APP_ZOOM_STEP : -APP_ZOOM_STEP;
    return normalizeAppZoom(currentZoom + delta);
}

export function increaseAppZoom() {
    return writeAppZoom(stepAppZoom(readAppZoom(), "in"));
}

export function decreaseAppZoom() {
    return writeAppZoom(stepAppZoom(readAppZoom(), "out"));
}

export function resetAppZoom() {
    return writeAppZoom(DEFAULT_APP_ZOOM);
}

export function subscribeAppZoom(listener: (zoom: number) => void) {
    return subscribeSafeStorage((event) => {
        if (event.key !== APP_ZOOM_STORAGE_KEY) {
            return;
        }

        listener(normalizeAppZoom(event.newValue));
    });
}
