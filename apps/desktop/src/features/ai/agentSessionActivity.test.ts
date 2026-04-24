import { describe, expect, it } from "vitest";
import { resolveAgentSessionActivity } from "./agentSessionActivity";

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
