import { describe, expect, it } from "vitest";
import {
    isAgentSessionActive,
    resolveAgentSessionActivity,
} from "./agentSessionActivity";

describe("isAgentSessionActive", () => {
    it("returns true for active live sessions", () => {
        expect(
            isAgentSessionActive({ runtimeState: "live", status: "streaming" }),
        ).toBe(true);

        expect(
            isAgentSessionActive({
                runtimeState: "live",
                status: "waiting_permission",
            }),
        ).toBe(true);

        expect(
            isAgentSessionActive({
                runtimeState: "live",
                status: "waiting_user_input",
            }),
        ).toBe(true);
    });

    it("returns true when runtimeState is missing", () => {
        expect(
            isAgentSessionActive({ runtimeState: undefined, status: "streaming" }),
        ).toBe(true);
    });

    it("returns false for idle or error live sessions", () => {
        expect(
            isAgentSessionActive({ runtimeState: "live", status: "idle" }),
        ).toBe(false);

        expect(
            isAgentSessionActive({ runtimeState: "live", status: "error" }),
        ).toBe(false);
    });

    it("returns false when runtime is not live", () => {
        expect(
            isAgentSessionActive({
                runtimeState: "persisted_only",
                status: "streaming",
            }),
        ).toBe(false);
    });

    it("returns false for null or undefined session", () => {
        expect(isAgentSessionActive(null)).toBe(false);
        expect(isAgentSessionActive(undefined)).toBe(false);
    });
});

describe("resolveAgentSessionActivity", () => {
    it("returns a working indicator for active live sessions", () => {
        expect(
            resolveAgentSessionActivity({
                runtimeState: "live",
                status: "streaming",
            }),
        ).toEqual({
            title: "Agent busy",
            tone: "working",
        });

        expect(
            resolveAgentSessionActivity({
                runtimeState: "live",
                status: "waiting_permission",
            }),
        ).toEqual({
            title: "Agent busy",
            tone: "working",
        });
    });

    it("returns an error indicator for live failed sessions", () => {
        expect(
            resolveAgentSessionActivity({
                runtimeState: "live",
                status: "error",
            }),
        ).toEqual({
            title: "Agent error",
            tone: "danger",
        });
    });

    it("hides activity for idle or non-live sessions", () => {
        expect(
            resolveAgentSessionActivity({
                runtimeState: "live",
                status: "idle",
            }),
        ).toBeNull();

        expect(
            resolveAgentSessionActivity({
                runtimeState: "persisted_only",
                status: "streaming",
            }),
        ).toBeNull();
    });
});
