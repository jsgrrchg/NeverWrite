import { describe, expect, it } from "vitest";
import { reconcileInheritedAcpOptions } from "./acpSelection";
import type { AIConfigOption, ConversationSelection } from "./types";

const effort: AIConfigOption = {
    id: "effort",
    runtimeId: "opencode-acp",
    category: "reasoning",
    label: "Effort",
    type: "select",
    value: "high",
    options: ["low", "high"].map((value) => ({ value, label: value })),
};
const selection: ConversationSelection = {
    runtimeId: effort.runtimeId,
    modelId: "model",
    modeId: "default",
    options: { effort: "high" },
};
const session = { runtimeId: effort.runtimeId, modelId: "model", configOptions: [] as AIConfigOption[] };

describe("reconcileInheritedAcpOptions", () => {
    it("drops a saved option absent from the new session without mutating the preference", () => {
        expect(reconcileInheritedAcpOptions(session, selection, [effort]).options).toEqual({});
        expect(selection.options).toEqual({ effort: "high" });
    });

    it("preserves supported values, including options first exposed by the target model", () => {
        expect(reconcileInheritedAcpOptions(
            { ...session, configOptions: [effort] }, selection, [],
        )).toEqual(selection);
    });

    it("adopts the agent's current value when a previously supported value expires", () => {
        const current = { ...effort, value: "medium", options: [{ value: "medium", label: "Medium" }] };
        expect(reconcileInheritedAcpOptions(
            { ...session, configOptions: [current] }, selection, [effort],
        ).options).toEqual({ effort: "medium" });
    });

    it("preserves unknown ids and never-advertised values for strict validation", () => {
        const requested = { ...selection, options: { effort: "invented", unknown: "high" } };
        expect(reconcileInheritedAcpOptions(session, requested, [effort])).toEqual(requested);
    });

    it("does not treat a rejected supported change as a fallback", () => {
        const current = { ...effort, value: "low" };
        expect(reconcileInheritedAcpOptions(
            { ...session, configOptions: [current] }, selection, [effort],
        ).options).toEqual({ effort: "high" });
    });

    it("does not inherit catalogs from another provider or reconcile before selecting the target model", () => {
        expect(reconcileInheritedAcpOptions(session, selection, [{ ...effort, runtimeId: "other" }])).toEqual(selection);
        expect(reconcileInheritedAcpOptions({ ...session, modelId: "other" }, selection, [effort])).toEqual(selection);
        expect(reconcileInheritedAcpOptions({ ...session, runtimeId: "other" }, selection, [effort])).toEqual(selection);
    });

    it("keeps model and mode options strict even when their ids are provider-defined", () => {
        const previous = [
            { ...effort, id: "agent", category: "mode" as const },
            { ...effort, id: "llm", category: "model" as const },
        ];
        const requested = { ...selection, options: { agent: "high", llm: "high" } };
        expect(reconcileInheritedAcpOptions(session, requested, previous)).toEqual(requested);
    });
});
