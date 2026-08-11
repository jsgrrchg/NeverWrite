import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AIChatAgentControls } from "./AIChatAgentControls";

describe("AIChatAgentControls", () => {
  beforeEach(() => {
    localStorage.removeItem("neverwrite.ai.provider-model-picker-favorites");
  });

  it("shows provider choices and exposes disabled reasons", async () => {
    const user = userEvent.setup();
    const onProviderChange = vi.fn();
    renderComponent(
      <AIChatAgentControls
        runtimeId="codex-acp"
        modelId="gpt-5"
        modeId="default"
        models={[]}
        modes={[]}
        configOptions={[]}
        providers={[
          {
            runtimeId: "codex-acp",
            label: "Codex",
            description: "Codex provider",
            disabledReason: null,
            defaultModelId: "gpt-5",
            models: [
              {
                modelId: "gpt-5",
                label: "GPT-5",
                disabledReason: null,
              },
            ],
          },
          {
            runtimeId: "claude-acp",
            label: "Claude",
            description: "Claude provider",
            disabledReason:
              "Finish the current turn before switching providers.",
            defaultModelId: "claude-sonnet",
            models: [
              {
                modelId: "claude-sonnet",
                label: "Claude Sonnet",
                disabledReason: null,
              },
            ],
          },
        ]}
        onProviderModelChange={onProviderChange}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    await user.click(screen.getByTitle("Provider and model"));
    const modelMenu = screen.getByRole("dialog", {
      name: "Provider and model",
    });
    expect(modelMenu).toHaveClass("nw-chat-glass-menu");
    expect(modelMenu.parentElement).toBe(document.body);
    expect(screen.getByLabelText("Provider and model search")).toHaveFocus();
    await user.type(
      screen.getByLabelText("Provider and model search"),
      "claude",
    );
    const disabledClaude = screen.getByRole("button", {
      name: "Claude · Claude Sonnet",
    });
    expect(disabledClaude).toBeDisabled();
    expect(disabledClaude).toHaveAttribute(
      "title",
      "Finish the current turn before switching providers.",
    );
    await user.clear(screen.getByLabelText("Provider and model search"));
    const codexOption = screen
      .getAllByRole("button", { name: "Codex · GPT 5" })
      .find((button) => button.getAttribute("title") === "Codex provider");
    expect(codexOption).toBeDefined();
    await user.click(codexOption!);
    expect(onProviderChange).toHaveBeenCalledWith("codex-acp", "gpt-5");
  });

  it("keeps the original provider selected and explains the lock inline", async () => {
    const user = userEvent.setup();
    const onProviderChange = vi.fn();
    renderComponent(
      <AIChatAgentControls
        runtimeId="codex-acp"
        providerSwitchLocked
        modelId="gpt-5"
        modeId="default"
        models={[]}
        modes={[]}
        configOptions={[]}
        providers={[
          {
            runtimeId: "codex-acp",
            label: "Codex",
            description: "Codex provider",
            disabledReason: null,
            defaultModelId: "gpt-5",
            models: [
              {
                modelId: "gpt-5",
                label: "GPT-5",
                disabledReason: null,
              },
            ],
          },
          {
            runtimeId: "claude-acp",
            label: "Claude",
            description: "Claude provider",
            disabledReason: null,
            defaultModelId: "claude-sonnet",
            models: [
              {
                modelId: "claude-sonnet",
                label: "Claude Sonnet",
                disabledReason: null,
              },
            ],
          },
        ]}
        onProviderModelChange={onProviderChange}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    await user.click(screen.getByTitle("Provider and model"));
    const claudeRail = screen.getByRole("button", { name: "Claude" });
    expect(claudeRail).toHaveAttribute("aria-disabled", "true");
    await user.click(claudeRail);

    expect(
      screen.getByTestId("provider-switch-blocked-popover"),
    ).toHaveTextContent(
      "This chat is locked to Codex. Start a new chat to use Claude.",
    );
    expect(
      screen.getByRole("button", { name: "Codex · GPT 5" }),
    ).toBeInTheDocument();
    expect(onProviderChange).not.toHaveBeenCalled();

    await user.type(
      screen.getByLabelText("Provider and model search"),
      "claude",
    );
    await user.click(
      screen.getByRole("button", { name: "Claude · Claude Sonnet" }),
    );
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Provider and model" }),
    ).toBeInTheDocument();
  });

  it("persists favorite models and opens the favorites rail first", async () => {
    const user = userEvent.setup();
    renderComponent(
      <AIChatAgentControls
        runtimeId="codex-acp"
        modelId="gpt-5"
        modeId="default"
        models={[]}
        modes={[]}
        configOptions={[]}
        providers={[
          {
            runtimeId: "codex-acp",
            label: "Codex",
            description: "Codex provider",
            disabledReason: null,
            defaultModelId: "gpt-5",
            models: [
              {
                modelId: "gpt-5",
                label: "GPT-5",
                disabledReason: null,
              },
              {
                modelId: "gpt-5-mini",
                label: "GPT-5 Mini",
                disabledReason: null,
              },
            ],
          },
        ]}
        onProviderModelChange={() => {}}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    await user.click(screen.getByTitle("Provider and model"));
    await user.click(
      screen.getByRole("button", {
        name: "Add GPT-5 Mini to favorites",
      }),
    );
    await user.click(screen.getByTitle("Provider and model"));
    await user.click(screen.getByTitle("Provider and model"));

    expect(screen.getByRole("button", { name: "Favorites" })).toHaveStyle({
      backgroundColor: "var(--bg-primary)",
    });
    expect(
      screen.getByRole("button", { name: "Codex · GPT-5 Mini" }),
    ).toBeInTheDocument();
    expect(
      JSON.parse(
        localStorage.getItem("neverwrite.ai.provider-model-picker-favorites") ??
          "[]",
      ),
    ).toContainEqual({
      runtimeId: "codex-acp",
      modelId: "gpt-5-mini",
    });
  });

  it("shows contextual safety help only for Codex Full Access", () => {
    const fullAccessDescription =
      "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.";
    const modes = [
      {
        id: "auto",
        runtimeId: "codex-acp",
        name: "Default",
        description: "Work inside the current workspace.",
        disabled: false,
      },
      {
        id: "full-access",
        runtimeId: "codex-acp",
        name: "Full Access",
        description: fullAccessDescription,
        disabled: false,
      },
    ];
    const view = renderComponent(
      <AIChatAgentControls
        runtimeId="codex-acp"
        modelId=""
        modeId="full-access"
        effortsByModel={{}}
        models={[]}
        modes={modes}
        configOptions={[]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    const help = screen.getByRole("button", {
      name: "Full Access safety policy",
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Some destructive command forms may still be blocked by Codex safety policy.",
    );
    fireEvent.mouseLeave(help);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(help);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.blur(help);

    fireEvent.click(screen.getByTitle("Approval Preset"));
    const fullAccessOption = screen
      .getAllByRole("button", { name: "Full Access" })
      .find((option) => option.getAttribute("title") === fullAccessDescription);
    expect(fullAccessOption).toHaveAttribute("title", fullAccessDescription);

    view.unmount();
    renderComponent(
      <AIChatAgentControls
        runtimeId="codex-acp"
        modelId=""
        modeId="auto"
        effortsByModel={{}}
        models={[]}
        modes={modes}
        configOptions={[]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Full Access safety policy",
      }),
    ).not.toBeInTheDocument();
  });

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

    fireEvent.click(screen.getByTitle("Reasoning"));

    expect(screen.getAllByText("Medium")).toHaveLength(2);
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("Very High")).toBeInTheDocument();
    expect(screen.queryByText("Service Tier")).not.toBeInTheDocument();
  });

  it("keeps ACP reasoning options when discovery metadata is empty", () => {
    renderComponent(
      <AIChatAgentControls
        runtimeId="claude-acp"
        modelId="claude-haiku-4-5"
        modeId="default"
        effortsByModel={{
          "claude-sonnet-4-5": ["low", "medium", "high"],
          "claude-haiku-4-5": [],
        }}
        models={[
          {
            id: "claude-haiku-4-5",
            runtimeId: "claude-acp",
            name: "Claude Haiku 4.5",
            description: "",
          },
        ]}
        modes={[
          {
            id: "default",
            runtimeId: "claude-acp",
            name: "Auto",
            description: "",
            disabled: false,
          },
        ]}
        configOptions={[
          {
            id: "effort",
            runtimeId: "claude-acp",
            category: "reasoning",
            label: "Effort",
            type: "select",
            value: "medium",
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    expect(screen.getByTitle("Reasoning and Service Tier")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
  });

  it("hides a thought level config option duplicated by ACP modes", () => {
    renderComponent(
      <AIChatAgentControls
        runtimeId="custom:pi"
        modelId=""
        modeId="low"
        models={[]}
        modes={[
          {
            id: "off",
            runtimeId: "custom:pi",
            name: "Thinking: off",
            description: "",
            disabled: false,
          },
          {
            id: "low",
            runtimeId: "custom:pi",
            name: "Thinking: low",
            description: "",
            disabled: false,
          },
          {
            id: "high",
            runtimeId: "custom:pi",
            name: "Thinking: high",
            description: "",
            disabled: false,
          },
        ]}
        configOptions={[
          {
            id: "thought_level",
            runtimeId: "custom:pi",
            category: "reasoning",
            label: "Thinking",
            type: "select",
            value: "low",
            options: [
              { value: "off", label: "Thinking: off" },
              { value: "low", label: "Thinking: low" },
              { value: "high", label: "Thinking: high" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    expect(screen.getByTitle("Approval Preset")).toBeInTheDocument();
    expect(screen.queryByTitle("Thinking")).not.toBeInTheDocument();
  });

  it("groups Codex reasoning and service tier while preserving ACP values", () => {
    const onConfigOptionChange = vi.fn();

    renderComponent(
      <AIChatAgentControls
        runtimeId="codex-acp"
        modelId="gpt-5.6"
        modeId="default"
        effortsByModel={{}}
        models={[]}
        modes={[]}
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
            ],
          },
          {
            id: "service_tier",
            runtimeId: "codex-acp",
            category: "service_tier",
            label: "Fast Mode",
            type: "select",
            value: "off",
            options: [
              { value: "off", label: "Off" },
              { value: "fast", label: "Fast" },
              { value: "flex", label: "Flex" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={onConfigOptionChange}
      />,
    );

    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.queryByTitle("Fast Mode")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Reasoning and Service Tier"));

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Service Tier")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Standard Default" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Flex" })).toBeInTheDocument();
    const traitMenu = screen
      .getByRole("button", { name: "Fast" })
      .closest(".nw-chat-glass-menu");
    expect(traitMenu).not.toBeNull();
    expect(traitMenu?.parentElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Fast" }));

    expect(onConfigOptionChange).toHaveBeenCalledWith("service_tier", "fast");
  });

  it("presents a legacy Claude fast option as a service tier", () => {
    const onConfigOptionChange = vi.fn();

    renderComponent(
      <AIChatAgentControls
        runtimeId="claude-acp"
        modelId="claude-sonnet-5"
        modeId="default"
        effortsByModel={{}}
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "fast",
            runtimeId: "claude-acp",
            category: "other",
            label: "Fast mode",
            type: "select",
            value: "off",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={onConfigOptionChange}
      />,
    );

    fireEvent.click(screen.getByTitle("Service Tier"));

    expect(screen.getByRole("button", { name: "Fast" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "On" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Standard Default" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fast" }));

    expect(onConfigOptionChange).toHaveBeenCalledWith("fast", "on");
  });

  it("shows Claude service tier and gates Fast by the selected model", () => {
    const onConfigOptionChange = vi.fn();
    const { rerender } = renderComponent(
      <AIChatAgentControls
        runtimeId="claude-acp"
        modelId="default"
        modeId="default"
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "effort",
            runtimeId: "claude-acp",
            category: "reasoning",
            label: "Effort",
            type: "select",
            value: "high",
            options: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={onConfigOptionChange}
      />,
    );

    fireEvent.click(screen.getByTitle("Reasoning and Service Tier"));
    expect(screen.getByRole("button", { name: "Fast" })).toBeDisabled();
    fireEvent.click(screen.getByTitle("Reasoning and Service Tier"));

    rerender(
      <AIChatAgentControls
        runtimeId="claude-acp"
        modelId="opus"
        modeId="default"
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "effort",
            runtimeId: "claude-acp",
            category: "reasoning",
            label: "Effort",
            type: "select",
            value: "high",
            options: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={onConfigOptionChange}
      />,
    );

    fireEvent.click(screen.getByTitle("Reasoning and Service Tier"));
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    expect(onConfigOptionChange).toHaveBeenCalledWith("fast", "on");
  });

  it("does not reinterpret an unrelated fast option from another ACP", () => {
    renderComponent(
      <AIChatAgentControls
        runtimeId="custom:example"
        modelId="example-model"
        modeId="default"
        effortsByModel={{}}
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "fast",
            runtimeId: "custom:example",
            category: "other",
            label: "Fast Mode",
            type: "select",
            value: "off",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    expect(screen.getByTitle("Fast Mode")).toBeInTheDocument();
    expect(screen.queryByTitle("Service Tier")).not.toBeInTheDocument();
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

    expect(onConfigOptionChange).toHaveBeenCalledWith("model", "gpt-5.2-codex");
  });

  it("disables Grok models that require a different agent after the chat starts", () => {
    const onConfigOptionChange = vi.fn();

    renderComponent(
      <AIChatAgentControls
        runtimeId="grok-acp"
        lockIncompatibleModelSwitches
        modelId=""
        modeId="yolo"
        effortsByModel={{}}
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "model",
            runtimeId: "grok-acp",
            category: "model",
            label: "Model",
            type: "select",
            value: "grok-build",
            options: [
              {
                value: "grok-composer-2.5-fast",
                label: "Composer 2.5",
                agentType: "cursor",
              },
              {
                value: "grok-build",
                label: "Grok Build",
                agentType: "grok-build-plan",
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

    const composer = screen.getByRole("button", {
      name: "Composer 2.5",
    });
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute(
      "title",
      "Start a new Grok chat to switch to this model.",
    );

    fireEvent.click(composer);
    expect(onConfigOptionChange).not.toHaveBeenCalled();
  });

  it("shows a model search field for Kilo and filters results", () => {
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
    expect(screen.getAllByText("Kilo Gateway/OpenAI: GPT-4o")).toHaveLength(1);
    expect(
      screen.queryByText("Kilo Gateway/Google: Gemini 2.5 Pro"),
    ).not.toBeInTheDocument();
  });

  it("shows a model search field for OpenCode and filters Zen models", () => {
    const onConfigOptionChange = vi.fn();

    renderComponent(
      <AIChatAgentControls
        runtimeId="opencode-acp"
        modelId="opencode/zen/qwen3.5-plus"
        modeId="default"
        effortsByModel={{}}
        models={[]}
        modes={[
          {
            id: "default",
            runtimeId: "opencode-acp",
            name: "Auto",
            description: "",
            disabled: false,
          },
        ]}
        configOptions={[
          {
            id: "model",
            runtimeId: "opencode-acp",
            category: "model",
            label: "Model",
            type: "select",
            value: "opencode/zen/qwen3.5-plus",
            options: [
              {
                value: "opencode/zen/qwen3.5-plus",
                label: "OpenCode Zen/Qwen3.5 Plus",
              },
              {
                value: "opencode/zen/gemini-3-flash",
                label: "OpenCode Zen/Gemini 3 Flash",
              },
              {
                value: "opencode/zen/claude-opus-4.7",
                label: "OpenCode Zen/Claude Opus 4.7",
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
    expect(screen.getByText("OpenCode Zen/Gemini 3 Flash")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "opus" } });

    expect(
      screen.getByText("OpenCode Zen/Claude Opus 4.7"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("OpenCode Zen/Gemini 3 Flash"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "OpenCode Zen/Claude Opus 4.7",
      }),
    );

    expect(onConfigOptionChange).toHaveBeenCalledWith(
      "model",
      "opencode/zen/claude-opus-4.7",
    );
  });

  it("shows Grok ACP models without a model search field", () => {
    const onConfigOptionChange = vi.fn();

    renderComponent(
      <AIChatAgentControls
        runtimeId="grok-acp"
        modelId="grok-build"
        modeId=""
        effortsByModel={{}}
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "model",
            runtimeId: "grok-acp",
            category: "model",
            label: "Model",
            type: "select",
            value: "grok-build",
            options: [
              {
                value: "grok-composer-2.5-fast",
                label: "Composer 2.5",
                description: "Cursor's latest coding model",
              },
              {
                value: "grok-build",
                label: "Grok Build",
                description: "Best for advanced coding tasks",
              },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={onConfigOptionChange}
      />,
    );

    expect(screen.queryByTitle("Approval Preset")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Model"));

    expect(screen.queryByLabelText("Model search")).not.toBeInTheDocument();
    expect(screen.getByText("Composer 2.5")).toBeInTheDocument();
    expect(screen.getAllByText("Grok Build").length).toBeGreaterThan(0);

    const grokBuildOption = screen
      .getAllByRole("button", { name: "Grok Build" })
      .at(-1);
    expect(grokBuildOption).toBeDefined();
    fireEvent.click(grokBuildOption!);

    expect(onConfigOptionChange).toHaveBeenCalledWith("model", "grok-build");
  });

  it("shows the model label when model options exist but no value is selected", () => {
    renderComponent(
      <AIChatAgentControls
        runtimeId="grok-acp"
        modelId=""
        modeId=""
        effortsByModel={{}}
        models={[]}
        modes={[]}
        configOptions={[
          {
            id: "model",
            runtimeId: "grok-acp",
            category: "model",
            label: "Model",
            type: "select",
            value: "",
            options: [
              { value: "composer-2.5", label: "Composer 2.5" },
              { value: "grok-build", label: "Grok Build" },
            ],
          },
        ]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    expect(screen.getByTitle("Model")).toHaveTextContent("Model");
  });

  it("hides the model selector when there are no real model options", () => {
    renderComponent(
      <AIChatAgentControls
        runtimeId="grok-acp"
        modelId=""
        modeId="yolo"
        effortsByModel={{}}
        models={[]}
        modes={[
          {
            id: "yolo",
            runtimeId: "grok-acp",
            name: "YOLO",
            description: "",
            disabled: false,
          },
        ]}
        configOptions={[]}
        onModelChange={() => {}}
        onModeChange={() => {}}
        onConfigOptionChange={() => {}}
      />,
    );

    expect(screen.queryByTitle("Model")).not.toBeInTheDocument();
    expect(screen.getByTitle("Approval Preset")).toBeInTheDocument();
  });

  it("does not show the model search field for non-searchable runtimes", () => {
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
