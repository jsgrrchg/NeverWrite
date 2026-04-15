import { beforeEach, describe, expect, it } from "vitest";
import {
    APP_ZOOM_STORAGE_KEY,
    DEFAULT_APP_ZOOM,
    MAX_APP_ZOOM,
    MIN_APP_ZOOM,
    normalizeAppZoom,
    readAppZoom,
    resetAppZoom,
    stepAppZoom,
    writeAppZoom,
} from "./appZoom";

describe("appZoom", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("normalizes invalid and out-of-range values", () => {
        expect(normalizeAppZoom("bad")).toBe(DEFAULT_APP_ZOOM);
        expect(normalizeAppZoom(MIN_APP_ZOOM - 1)).toBe(MIN_APP_ZOOM);
        expect(normalizeAppZoom(MAX_APP_ZOOM + 1)).toBe(MAX_APP_ZOOM);
    });

    it("steps zoom in both directions", () => {
        expect(stepAppZoom(1, "in")).toBe(1.1);
        expect(stepAppZoom(1, "out")).toBe(0.9);
    });

    it("persists and restores app zoom", () => {
        writeAppZoom(1.3);
        expect(localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe("1.3");
        expect(readAppZoom()).toBe(1.3);
    });

    it("resets to the default zoom", () => {
        writeAppZoom(1.4);
        expect(resetAppZoom()).toBe(DEFAULT_APP_ZOOM);
        expect(readAppZoom()).toBe(DEFAULT_APP_ZOOM);
    });
});
