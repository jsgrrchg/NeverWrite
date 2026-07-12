import { describe, expect, it } from "vitest";
import {
    getChatVaultReferenceLabel,
    parseChatVaultReferenceTarget,
    serializeChatVaultReferenceTarget,
} from "./chatVaultReferenceTarget";

describe("chatVaultReferenceTarget", () => {
    it.each([
        ["CHANGELOG.md:66", 66, null],
        ["CHANGELOG.md#L66", 66, null],
        ["CHANGELOG.md#L66-L70", 66, 70],
        ["CHANGELOG.md#L66-70", 66, 70],
        ["CHANGELOG.md:66-70", 66, 70],
    ])("parses %s", (reference, line, endLine) => {
        expect(parseChatVaultReferenceTarget(reference)).toEqual({
            path: "CHANGELOG.md",
            line,
            endLine,
        });
    });

    it("leaves ordinary paths and Windows drive letters intact", () => {
        expect(parseChatVaultReferenceTarget("C:/vault/CHANGELOG.md")).toEqual({
            path: "C:/vault/CHANGELOG.md",
            line: null,
            endLine: null,
        });
    });

    it("normalizes serialization and formats user-facing line labels", () => {
        const target = parseChatVaultReferenceTarget("CHANGELOG.md:66-70");
        expect(serializeChatVaultReferenceTarget(target)).toBe(
            "CHANGELOG.md#L66-70",
        );
        expect(getChatVaultReferenceLabel("CHANGELOG.md", target)).toBe(
            "CHANGELOG.md (lines 66–70)",
        );
        expect(
            getChatVaultReferenceLabel("CHANGELOG.md (lines 66–70)", target),
        ).toBe("CHANGELOG.md (lines 66–70)");
    });
});
