import type { AIRuntimeDescriptor } from "../types";

interface RuntimeMetadata {
    id: string;
    name: string;
    company: string;
    description: string;
    capabilities: string[];
}

const RUNTIME_METADATA: RuntimeMetadata[] = [
    {
        id: "codex-acp",
        name: "Codex",
        company: "OpenAI",
        description: "Codex runtime embedded as an ACP sidecar.",
        capabilities: [
            "attachments",
            "permissions",
            "reasoning",
            "terminal_output",
            "create_session",
            "list_sessions",
            "user_input",
        ],
    },
    {
        id: "claude-acp",
        name: "Claude",
        company: "Anthropic",
        description: "Claude runtime exposed through the upstream ACP adapter.",
        capabilities: [
            "attachments",
            "permissions",
            "reasoning",
            "plans",
            "terminal_output",
            "create_session",
            "fork_session",
            "resume_session",
            "list_sessions",
            "prompt_queueing",
        ],
    },
    {
        id: "gemini-acp",
        name: "Gemini",
        company: "Google",
        description: "Gemini CLI running as a native ACP agent.",
        capabilities: [
            "attachments",
            "permissions",
            "plans",
            "create_session",
            "resume_session",
        ],
    },
    {
        id: "kilo-acp",
        name: "Kilo",
        company: "Kilo Code",
        description: "Kilo CLI running as a native ACP agent.",
        capabilities: [
            "attachments",
            "permissions",
            "plans",
            "terminal_output",
            "create_session",
            "fork_session",
            "resume_session",
            "list_sessions",
        ],
    },
];

export const PROVIDER_CATALOG = RUNTIME_METADATA.map(
    ({ id, name, company }) => ({
        id,
        name,
        company,
    }),
);

export function getRuntimeDisplayName(
    runtimeId?: string | null,
    runtimeName?: string | null,
) {
    const explicitName = runtimeName?.trim();
    if (explicitName) {
        return explicitName.replace(/ ACP$/, "");
    }

    if (!runtimeId) {
        return "Assistant";
    }

    return (
        RUNTIME_METADATA.find((runtime) => runtime.id === runtimeId)?.name ??
        runtimeId
    );
}

export function buildFallbackRuntimeDescriptors(): AIRuntimeDescriptor[] {
    return RUNTIME_METADATA.map((runtime) => ({
        runtime: {
            id: runtime.id,
            name: `${runtime.name} ACP`,
            description: runtime.description,
            capabilities: [...runtime.capabilities],
        },
        models: [],
        modes: [],
        configOptions: [],
    }));
}
