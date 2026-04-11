const CLAUDE_TERMINAL_AUTH_METHOD_IDS = new Set([
    "claude-login",
    "claude-ai-login",
    "console-login",
]);

export function isClaudeTerminalAuthMethodId(id?: string) {
    return id !== undefined && CLAUDE_TERMINAL_AUTH_METHOD_IDS.has(id);
}

export function isIntegratedTerminalAuthMethod(
    runtimeId?: string,
    methodId?: string,
) {
    if (!runtimeId || !methodId) {
        return false;
    }

    if (runtimeId === "claude-acp") {
        return isClaudeTerminalAuthMethodId(methodId);
    }

    if (runtimeId === "gemini-acp") {
        return methodId === "login_with_google";
    }

    if (runtimeId === "kilo-acp") {
        return methodId === "kilo-login";
    }

    return false;
}

export function isIntegratedTerminalAuthMethodId(methodId?: string) {
    return (
        isClaudeTerminalAuthMethodId(methodId) ||
        methodId === "login_with_google" ||
        methodId === "kilo-login"
    );
}
