import { describe, expect, it } from "vitest";
import { getFocusedCameraPosition, getGraphFocusDistance } from "./graphCamera";

describe("getFocusedCameraPosition", () => {
    it("keeps the camera on the current viewing vector", () => {
        expect(
            getFocusedCameraPosition(
                { x: 10, y: 20, z: 30 },
                { x: 10, y: 20, z: 130 },
                40,
            ),
        ).toEqual({
            x: 10,
            y: 20,
            z: 70,
        });
    });

    it("falls back to a forward z offset when camera and node overlap", () => {
        expect(
            getFocusedCameraPosition(
                { x: 0, y: 0, z: 0 },
                { x: 0, y: 0, z: 0 },
                72,
            ),
        ).toEqual({
            x: 0,
            y: 0,
            z: 72,
        });
    });
});

describe("getGraphFocusDistance", () => {
    it("keeps a comfortable minimum distance for low-importance nodes", () => {
        expect(getGraphFocusDistance(null, 1)).toBe(98);
    });

    it("backs off more when the current camera is far away", () => {
        expect(getGraphFocusDistance(500, 1)).toBe(160);
    });

    it("caps the distance to avoid flying too far out", () => {
        expect(getGraphFocusDistance(2000, 16)).toBe(220);
    });
});
