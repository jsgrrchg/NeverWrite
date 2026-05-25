import { describe, expect, it } from "vitest";
import {
    appendTerminalRawOutput,
    normalizePersistedTerminalRawOutput,
} from "./terminalRawOutput";

describe("appendTerminalRawOutput", () => {
    it("appends chunks when combined size is within the 2M limit", () => {
        expect(appendTerminalRawOutput("hello ", "world")).toBe("hello world");
    });

    it("does nothing when chunk is empty", () => {
        expect(appendTerminalRawOutput("hello", "")).toBe("hello");
    });

    it("accumulates up to 2 million characters without trimming", () => {
        const chunk = "x".repeat(500_000);
        let output = "";
        for (let i = 0; i < 4; i++) {
            output = appendTerminalRawOutput(output, chunk);
        }
        expect(output).toHaveLength(2_000_000);
    });

    it("trims from the front when output exceeds 2 million characters", () => {
        // 1_999_990 a's + 20 b's = 2_000_010 — 10 chars over the limit
        const base = "a".repeat(1_999_990);
        const overflow = "b".repeat(20);
        const result = appendTerminalRawOutput(base, overflow);

        // Trimmed to exactly 2M from the tail: 1_999_980 a's + 20 b's
        expect(result).toHaveLength(2_000_000);
        expect(result.endsWith("b".repeat(20))).toBe(true);
        expect(result.startsWith("a".repeat(1_999_980))).toBe(true);
    });

    it("keeps only the last 2M characters when a single chunk far exceeds the limit", () => {
        const huge = "z".repeat(3_000_000);
        const result = appendTerminalRawOutput("", huge);
        expect(result).toHaveLength(2_000_000);
        expect(result).toBe("z".repeat(2_000_000));
    });
});

describe("normalizePersistedTerminalRawOutput", () => {
    it("trims persisted output to 120k characters", () => {
        const over = "y".repeat(130_000);
        const result = normalizePersistedTerminalRawOutput(over);
        expect(result).toHaveLength(120_000);
        expect(result).toBe("y".repeat(120_000));
    });

    it("returns empty string for null", () => {
        expect(normalizePersistedTerminalRawOutput(null)).toBe("");
    });

    it("returns the string unchanged when under the limit", () => {
        expect(normalizePersistedTerminalRawOutput("hello")).toBe("hello");
    });
});
