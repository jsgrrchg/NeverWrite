import { afterEach, describe, expect, it } from "vitest";
import {
    getSystemUsername,
    resetSystemUsernameCacheForTests,
    resolveSystemUsername,
} from "./systemUser";

describe("resolveSystemUsername", () => {
    it("prefers os.userInfo().username", () => {
        expect(
            resolveSystemUsername({ USER: "envuser" }, () => ({
                username: "osuser",
            })),
        ).toBe("osuser");
    });

    it("trims the os username", () => {
        expect(
            resolveSystemUsername({}, () => ({ username: "  simon  " })),
        ).toBe("simon");
    });

    it("falls back to USER when userInfo throws", () => {
        expect(
            resolveSystemUsername({ USER: "posixuser" }, () => {
                throw new Error("no passwd entry");
            }),
        ).toBe("posixuser");
    });

    it("falls back to USERNAME (Windows) when USER is absent", () => {
        expect(
            resolveSystemUsername({ USERNAME: "winuser" }, () => {
                throw new Error("no passwd entry");
            }),
        ).toBe("winuser");
    });

    it("falls back to env when the os username is empty", () => {
        expect(
            resolveSystemUsername({ USER: "envuser" }, () => ({
                username: "   ",
            })),
        ).toBe("envuser");
    });

    it("returns null when nothing is available", () => {
        expect(
            resolveSystemUsername({}, () => {
                throw new Error("no passwd entry");
            }),
        ).toBeNull();
        expect(
            resolveSystemUsername({ USER: "  " }, () => ({ username: "" })),
        ).toBeNull();
    });
});

describe("getSystemUsername", () => {
    afterEach(() => {
        resetSystemUsernameCacheForTests();
    });

    it("returns a stable value across calls", () => {
        const first = getSystemUsername();
        expect(getSystemUsername()).toBe(first);
        // On any real machine running the test suite this resolves.
        expect(typeof first === "string" || first === null).toBe(true);
    });
});
