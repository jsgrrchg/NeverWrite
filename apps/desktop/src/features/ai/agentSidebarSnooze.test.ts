import { describe, expect, it } from "vitest";
import {
    AGENT_SNOOZE_PRESETS,
    MAX_SAFE_TIMEOUT_DELAY,
    formatSnoozeWakeLabel,
    getSafeSnoozeDelay,
    resolveAgentSnoozeTimestamp,
} from "./agentSidebarSnooze";

describe("agentSidebarSnooze", () => {
    it("resolves every preset to a future timestamp", () => {
        const now = new Date(2026, 7, 14, 10, 30).getTime();
        expect(AGENT_SNOOZE_PRESETS.map((preset) => preset.label)).toEqual([
            "1 hour",
            "Later today",
            "Tomorrow",
            "Next week",
        ]);
        for (const preset of AGENT_SNOOZE_PRESETS) {
            expect(resolveAgentSnoozeTimestamp(preset.id, now)).toBeGreaterThan(
                now,
            );
        }
    });

    it("uses local calendar boundaries instead of fixed day durations", () => {
        const now = new Date(2026, 2, 7, 23, 30).getTime();
        const tomorrow = new Date(
            resolveAgentSnoozeTimestamp("tomorrow", now),
        );
        const nextWeek = new Date(
            resolveAgentSnoozeTimestamp("next-week", now),
        );
        expect(tomorrow.getDate()).toBe(8);
        expect(tomorrow.getHours()).toBe(9);
        expect(nextWeek.getDay()).toBe(1);
        expect(nextWeek.getHours()).toBe(9);
    });

    it("caps long timeout delays without overflowing", () => {
        expect(getSafeSnoozeDelay(0, Number.MAX_SAFE_INTEGER)).toBe(
            MAX_SAFE_TIMEOUT_DELAY,
        );
        expect(getSafeSnoozeDelay(100, 50)).toBe(0);
    });

    it("formats local today and tomorrow wake labels", () => {
        const now = new Date(2026, 7, 14, 10).getTime();
        expect(
            formatSnoozeWakeLabel(new Date(2026, 7, 14, 18).getTime(), now),
        ).toMatch(/^Today /);
        expect(
            formatSnoozeWakeLabel(new Date(2026, 7, 15, 9).getTime(), now),
        ).toMatch(/^Tomorrow /);
    });
});
