import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AIChatAgentControls } from "./AIChatAgentControls";

describe("AIChatAgentControls", () => {
    it("filters reasoning efforts to the selected model", () => {
        renderComponent(
            <AIChatAgentControls
                runtimeId="codex-acp"
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
                runtimeId="codex-acp"
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

    it("shows a model search field only for Kilo and filters results", () => {
        const onConfigOptionChange = vi.fn();

        renderComponent(
            <AIChatAgentControls
                runtimeId="kilo-acp"
                modelId="gpt-4o"
                modeId="default"
                effortsByModel={{}}
                models={[]}
                modes={[
                    {
                        id: "default",
                        runtimeId: "kilo-acp",
                        name: "Auto",
                        description: "",
                        disabled: false,
                    },
                ]}
                configOptions={[
                    {
                        id: "model",
                        runtimeId: "kilo-acp",
                        category: "model",
                        label: "Model",
                        type: "select",
                        value: "gpt-4o",
                        options: [
                            {
                                value: "gpt-4o",
                                label: "Kilo Gateway/OpenAI: GPT-4o",
                            },
                            {
                                value: "claude-sonnet-4.6",
                                label: "Kilo Gateway/Anthropic: Claude Sonnet 4.6",
                            },
                            {
                                value: "gemini-2.5-pro",
                                label: "Kilo Gateway/Google: Gemini 2.5 Pro",
                            },
                        ],
                    },
                ]}
                onModelChange={() => {}}
                onModeChange={() => {}}
                onConfigOptionChange={onConfigOptionChange}
            />,
        );

        fireEvent.click(screen.getByTitle("Model"));

        const search = screen.getByLabelText("Model search");
        expect(search).toBeInTheDocument();
        expect(
            screen.getAllByText("Kilo Gateway/OpenAI: GPT-4o").length,
        ).toBeGreaterThan(0);
        expect(
            screen.getByText("Kilo Gateway/Anthropic: Claude Sonnet 4.6"),
        ).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "claude" } });

        expect(
            screen.getByText("Kilo Gateway/Anthropic: Claude Sonnet 4.6"),
        ).toBeInTheDocument();
        expect(screen.getAllByText("Kilo Gateway/OpenAI: GPT-4o")).toHaveLength(
            1,
        );
        expect(
            screen.queryByText("Kilo Gateway/Google: Gemini 2.5 Pro"),
        ).not.toBeInTheDocument();
    });

    it("does not show the model search field for non-Kilo runtimes", () => {
        renderComponent(
            <AIChatAgentControls
                runtimeId="codex-acp"
                modelId="gpt-5.2-codex"
                modeId="default"
                effortsByModel={{}}
                models={[]}
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
                            {
                                value: "gpt-5.4",
                                label: "GPT 5.4",
                            },
                        ],
                    },
                ]}
                onModelChange={() => {}}
                onModeChange={() => {}}
                onConfigOptionChange={() => {}}
            />,
        );

        fireEvent.click(screen.getByTitle("Model"));

        expect(screen.queryByLabelText("Model search")).not.toBeInTheDocument();
    });

    it("preserves the current focus when selecting a pointer-driven mode", async () => {
        const user = userEvent.setup();
        const onModeChange = vi.fn();

        renderComponent(
            <div>
                <input aria-label="Composer focus target" />
                <AIChatAgentControls
                    runtimeId="codex-acp"
                    modelId="gpt-5.2-codex"
                    modeId="default"
                    effortsByModel={{}}
                    models={[
                        {
                            id: "gpt-5.2-codex",
                            runtimeId: "codex-acp",
                            name: "gpt-5.2-codex",
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
                        {
                            id: "review",
                            runtimeId: "codex-acp",
                            name: "Review mode",
                            description: "",
                            disabled: false,
                        },
                    ]}
                    configOptions={[]}
                    onModelChange={() => {}}
                    onModeChange={onModeChange}
                    onConfigOptionChange={() => {}}
                />
            </div>,
        );

        const composer = screen.getByLabelText("Composer focus target");
        composer.focus();
        expect(composer).toHaveFocus();

        await user.click(screen.getByTitle("Approval Preset"));
        await user.click(screen.getByRole("button", { name: "Review mode" }));

        expect(onModeChange).toHaveBeenCalledWith("review");
        expect(composer).toHaveFocus();
    });

    it("restores the previous focus after choosing a searchable model", async () => {
        const user = userEvent.setup();
        const onConfigOptionChange = vi.fn();

        renderComponent(
            <div>
                <input aria-label="Composer focus target" />
                <AIChatAgentControls
                    runtimeId="kilo-acp"
                    modelId="gpt-4o"
                    modeId="default"
                    effortsByModel={{}}
                    models={[]}
                    modes={[
                        {
                            id: "default",
                            runtimeId: "kilo-acp",
                            name: "Auto",
                            description: "",
                            disabled: false,
                        },
                    ]}
                    configOptions={[
                        {
                            id: "model",
                            runtimeId: "kilo-acp",
                            category: "model",
                            label: "Model",
                            type: "select",
                            value: "gpt-4o",
                            options: [
                                {
                                    value: "gpt-4o",
                                    label: "Kilo Gateway/OpenAI: GPT-4o",
                                },
                                {
                                    value: "claude-sonnet-4.6",
                                    label: "Kilo Gateway/Anthropic: Claude Sonnet 4.6",
                                },
                            ],
                        },
                    ]}
                    onModelChange={() => {}}
                    onModeChange={() => {}}
                    onConfigOptionChange={onConfigOptionChange}
                />
            </div>,
        );

        const composer = screen.getByLabelText("Composer focus target");
        composer.focus();
        expect(composer).toHaveFocus();

        await user.click(screen.getByTitle("Model"));

        const search = screen.getByLabelText("Model search");
        expect(search).toHaveFocus();

        await user.type(search, "claude");
        await user.click(
            screen.getByRole("button", {
                name: "Kilo Gateway/Anthropic: Claude Sonnet 4.6",
            }),
        );

        expect(onConfigOptionChange).toHaveBeenCalledWith(
            "model",
            "claude-sonnet-4.6",
        );
        expect(composer).toHaveFocus();
    });
});
