import type { AIRuntimeDescriptor, AIRuntimeSetupStatus } from "../types";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./runtimeMetadata";

export const CLAUDE_TERMINAL_DESCRIPTOR: AIRuntimeDescriptor = {
    runtime: {
        id: CLAUDE_TERMINAL_RUNTIME_ID,
        name: "Claude Code",
        description: "Claude Code CLI running in an integrated terminal tab.",
        capabilities: ["attachments"],
    },
    models: [],
    modes: [],
    configOptions: [],
};

export function buildClaudeTerminalSetupStatus(
    binaryFound: boolean,
): AIRuntimeSetupStatus {
    return {
        runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
        binaryReady: binaryFound,
        binarySource: "env",
        authReady: binaryFound,
        authMethods: [],
        onboardingRequired: false,
        message: binaryFound
            ? undefined
            : "claude not found in PATH. Install via: npm install -g @anthropic-ai/claude-code",
    };
}
