import type {
    AIChatSession,
    AIConfigOption,
    AIModeOption,
    AIModelOption,
    AIRuntimeOption,
} from "./types";

export const AI_RUNTIME_OPTIONS: AIRuntimeOption[] = [
    {
        id: "claude-acp",
        name: "Claude ACP",
        description: "Claude agent runtime with ACP-compatible tools.",
        capabilities: ["attachments", "permissions", "review"],
    },
    {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime with ACP session controls and review hooks.",
        capabilities: ["attachments", "permissions", "reasoning"],
    },
];

export const AI_MODEL_OPTIONS: AIModelOption[] = [
    {
        id: "claude-sonnet-4-5",
        runtimeId: "claude-acp",
        name: "Claude Sonnet",
        description: "Balanced speed and capability for note work.",
    },
    {
        id: "claude-opus-4-5",
        runtimeId: "claude-acp",
        name: "Claude Opus",
        description: "Higher capability model for larger reasoning tasks.",
    },
    {
        id: "gpt-5-codex",
        runtimeId: "codex-acp",
        name: "GPT-5 Codex",
        description: "General-purpose coding and editing model.",
    },
    {
        id: "codex-mini",
        runtimeId: "codex-acp",
        name: "Codex Mini",
        description: "Faster runtime for lightweight actions and iterations.",
    },
];

export const AI_MODE_OPTIONS: AIModeOption[] = [
    {
        id: "default",
        runtimeId: "claude-acp",
        name: "Default",
        description: "Prompt for dangerous operations.",
    },
    {
        id: "acceptEdits",
        runtimeId: "claude-acp",
        name: "Accept Edits",
        description: "Auto-accept file edit operations.",
    },
    {
        id: "plan",
        runtimeId: "claude-acp",
        name: "Plan",
        description: "Planning only, no actual tool execution.",
    },
    {
        id: "dontAsk",
        runtimeId: "claude-acp",
        name: "Don't Ask",
        description: "Deny actions that are not already approved.",
    },
    {
        id: "bypassPermissions",
        runtimeId: "claude-acp",
        name: "Bypass Permissions",
        description: "Skip all permission checks.",
        disabled: true,
    },
    {
        id: "default",
        runtimeId: "codex-acp",
        name: "Default",
        description: "Prompt for actions that need explicit approval.",
    },
    {
        id: "acceptEdits",
        runtimeId: "codex-acp",
        name: "Accept Edits",
        description: "Approve edit operations automatically.",
    },
    {
        id: "plan",
        runtimeId: "codex-acp",
        name: "Plan",
        description: "Reason first without executing tools.",
    },
    {
        id: "bypassPermissions",
        runtimeId: "codex-acp",
        name: "Bypass Permissions",
        description: "Skip permission checks when supported.",
        disabled: true,
    },
];

const AI_CONFIG_OPTION_TEMPLATES: AIConfigOption[] = [
    {
        id: "reasoning_effort",
        runtimeId: "codex-acp",
        category: "reasoning",
        label: "Reasoning Effort",
        description: "Choose how much reasoning effort the runtime should use.",
        type: "select",
        value: "medium",
        options: [
            {
                value: "low",
                label: "Low",
                description: "Faster answers with lighter reasoning.",
            },
            {
                value: "medium",
                label: "Medium",
                description: "Balanced default.",
            },
            {
                value: "high",
                label: "High",
                description: "Deeper reasoning with higher latency.",
            },
        ],
    },
];

export function getModelsForRuntime(runtimeId: string) {
    return AI_MODEL_OPTIONS.filter((model) => model.runtimeId === runtimeId);
}

export function getModesForRuntime(runtimeId: string) {
    return AI_MODE_OPTIONS.filter((mode) => mode.runtimeId === runtimeId);
}

export function getConfigOptionsForRuntime(runtimeId: string) {
    return AI_CONFIG_OPTION_TEMPLATES.filter(
        (option) => option.runtimeId === runtimeId,
    ).map((option) => ({ ...option, options: [...option.options] }));
}

function getDefaultModelId(runtimeId: string) {
    return getModelsForRuntime(runtimeId)[0]?.id ?? "";
}

function getDefaultModeId(runtimeId: string) {
    return getModesForRuntime(runtimeId)[0]?.id ?? "";
}

export function createEmptySession(
    runtimeId: string = AI_RUNTIME_OPTIONS[0]!.id,
): AIChatSession {
    return {
        sessionId: crypto.randomUUID(),
        status: "idle",
        runtimeId,
        modelId: getDefaultModelId(runtimeId),
        modeId: getDefaultModeId(runtimeId),
        models: getModelsForRuntime(runtimeId),
        modes: getModesForRuntime(runtimeId),
        configOptions: getConfigOptionsForRuntime(runtimeId),
        messages: [],
        attachments: [],
    };
}

export const AI_DEFAULT_SESSIONS: AIChatSession[] = [
    createEmptySession("claude-acp"),
    createEmptySession("codex-acp"),
];
