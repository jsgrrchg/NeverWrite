import { describe, expect, it } from "vitest";
import { getPathBaseName } from "./path";

describe("getPathBaseName", () => {
    it("supports unix-style paths", () => {
        expect(getPathBaseName("/vault/projects/main")).toBe("main");
    });

    it("supports windows-style paths", () => {
        expect(getPathBaseName("C:\\Vaults\\Work")).toBe("Work");
    });

    it("ignores trailing separators", () => {
        expect(getPathBaseName("C:\\Vaults\\Work\\")).toBe("Work");
    });
});
