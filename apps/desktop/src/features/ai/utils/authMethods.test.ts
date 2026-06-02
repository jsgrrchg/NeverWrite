import { describe, expect, it } from "vitest";
import {
    isIntegratedTerminalAuthMethod,
    isIntegratedTerminalAuthMethodId,
} from "./authMethods";

describe("authMethods", () => {
    it("recognizes integrated terminal auth methods by runtime", () => {
        expect(
            isIntegratedTerminalAuthMethod("claude-acp", "claude-login"),
        ).toBe(true);
        expect(
            isIntegratedTerminalAuthMethod(
                "gemini-acp",
                "login_with_google",
            ),
        ).toBe(true);
        expect(isIntegratedTerminalAuthMethod("grok-acp", "grok-login")).toBe(
            true,
        );
        expect(isIntegratedTerminalAuthMethod("kilo-acp", "kilo-login")).toBe(
            true,
        );
        expect(
            isIntegratedTerminalAuthMethod("opencode-acp", "opencode-login"),
        ).toBe(true);
    });

    it("rejects terminal auth methods for the wrong runtime", () => {
        expect(
            isIntegratedTerminalAuthMethod("kilo-acp", "login_with_google"),
        ).toBe(false);
        expect(
            isIntegratedTerminalAuthMethod("gemini-acp", "kilo-login"),
        ).toBe(false);
        expect(
            isIntegratedTerminalAuthMethod("grok-acp", "xai-api-key"),
        ).toBe(false);
        expect(
            isIntegratedTerminalAuthMethod("codex-acp", "kilo-login"),
        ).toBe(false);
        expect(
            isIntegratedTerminalAuthMethod("kilo-acp", "opencode-login"),
        ).toBe(false);
    });

    it("recognizes supported terminal auth method ids", () => {
        expect(isIntegratedTerminalAuthMethodId("claude-ai-login")).toBe(true);
        expect(isIntegratedTerminalAuthMethodId("login_with_google")).toBe(
            true,
        );
        expect(isIntegratedTerminalAuthMethodId("grok-login")).toBe(true);
        expect(isIntegratedTerminalAuthMethodId("kilo-login")).toBe(true);
        expect(isIntegratedTerminalAuthMethodId("opencode-login")).toBe(true);
        expect(isIntegratedTerminalAuthMethodId("openai-api-key")).toBe(false);
    });
});
