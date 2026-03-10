import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AIChatAgentControls } from "./AIChatAgentControls";

describe("AIChatAgentControls", () => {
    it("filters reasoning efforts to the selected model", () => {
        renderComponent(
            <AIChatAgentControls
                modelId="gpt-5.2-codex"
                modeId="default"
                effortsByModel={{
                    "gpt-5.2-codex": ["medium", "high"],
                    "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
                }}
                models={[
                    {
                        id: "gpt-5.2-codex",
                        runtimeId: "codex-acp",
                        name: "gpt-5.2-codex",
                        description: "",
                    },
                    {
                        id: "gpt-5.3-codex",
                        runtimeId: "codex-acp",
                        name: "gpt-5.3-codex",
                        description: "",
                    },
                ]}
                modes={[
                    {
                        id: "default",
                        runtimeId: "codex-acp",
                        name: "Auto",
                        description: "",
                        disabled: false,
                    },
                ]}
                configOptions={[
                    {
                        id: "reasoning_effort",
                        runtimeId: "codex-acp",
                        category: "reasoning",
                        label: "Reasoning Effort",
                        type: "select",
                        value: "medium",
                        options: [
                            { value: "low", label: "Low" },
                            { value: "medium", label: "Medium" },
                            { value: "high", label: "High" },
                            { value: "xhigh", label: "Very High" },
                        ],
                    },
                ]}
                onModelChange={() => {}}
                onModeChange={() => {}}
                onConfigOptionChange={() => {}}
            />,
        );

        fireEvent.click(screen.getByTitle("Reasoning Effort"));

        expect(screen.getAllByText("Medium")).toHaveLength(2);
        expect(screen.getByText("High")).toBeInTheDocument();
        expect(screen.queryByText("Low")).not.toBeInTheDocument();
        expect(screen.queryByText("Very High")).not.toBeInTheDocument();
    });

    it("uses the ACP model config option as the source of truth", () => {
        const onConfigOptionChange = vi.fn();

        renderComponent(
            <AIChatAgentControls
                modelId="fallback-model"
                modeId="default"
                effortsByModel={{
                    "gpt-5.2-codex": ["medium", "high"],
                }}
                models={[
                    {
                        id: "fallback-model",
                        runtimeId: "codex-acp",
                        name: "Fallback Model",
                        description: "",
                    },
                ]}
                modes={[
                    {
                        id: "default",
                        runtimeId: "codex-acp",
                        name: "Auto",
                        description: "",
                        disabled: false,
                    },
                ]}
                configOptions={[
                    {
                        id: "model",
                        runtimeId: "codex-acp",
                        category: "model",
                        label: "Model",
                        type: "select",
                        value: "gpt-5.2-codex",
                        options: [
                            {
                                value: "gpt-5.2-codex",
                                label: "GPT 5.2 Codex",
                            },
                        ],
                    },
                ]}
                onModelChange={() => {}}
                onModeChange={() => {}}
                onConfigOptionChange={onConfigOptionChange}
            />,
        );

        expect(screen.getByText("GPT 5.2 Codex")).toBeInTheDocument();
        expect(screen.queryByText("fallback-model")).not.toBeInTheDocument();

        fireEvent.click(screen.getByTitle("Model"));
        fireEvent.click(screen.getAllByText("GPT 5.2 Codex")[1]!);

        expect(onConfigOptionChange).toHaveBeenCalledWith(
            "model",
            "gpt-5.2-codex",
        );
    });
});
