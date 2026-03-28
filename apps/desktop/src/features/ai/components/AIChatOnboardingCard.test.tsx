import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AIChatOnboardingCard } from "./AIChatOnboardingCard";

const baseSetupStatus = {
    runtimeId: "claude-acp",
    binaryReady: true,
    binarySource: "bundled" as const,
    authReady: false,
    authMethods: [
        {
            id: "claude-login",
            name: "Claude login",
            description: "Open a terminal-based Claude login flow.",
        },
        {
            id: "gateway",
            name: "Custom gateway",
            description:
                "Use a custom Anthropic-compatible gateway just for VaultAI.",
        },
    ],
    onboardingRequired: true,
};

describe("AIChatOnboardingCard", () => {
    it("shows the integrated terminal CTA for Claude login", () => {
        renderComponent(
            <AIChatOnboardingCard
                runtime={{
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "",
                    capabilities: [],
                }}
                setupStatus={baseSetupStatus}
                onSaveSetup={vi.fn()}
                onAuthenticate={vi.fn()}
            />,
        );

        expect(
            screen.getByText(
                "VaultAI will open a limited sign-in terminal inside the app.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        ).toBeInTheDocument();
    });

    it("can clear a broken custom binary override", () => {
        const onSaveSetup = vi.fn();

        renderComponent(
            <AIChatOnboardingCard
                runtime={{
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "",
                    capabilities: [],
                }}
                setupStatus={{
                    ...baseSetupStatus,
                    binaryReady: false,
                    hasCustomBinaryPath: true,
                }}
                onSaveSetup={onSaveSetup}
                onAuthenticate={vi.fn()}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Reset custom path" }),
        );

        expect(onSaveSetup).toHaveBeenCalledWith({
            runtimeId: "claude-acp",
            customBinaryPath: "",
        });
    });

    it("can clear stored gateway settings", () => {
        const onSaveSetup = vi.fn();

        renderComponent(
            <AIChatOnboardingCard
                runtime={{
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "",
                    capabilities: [],
                }}
                setupStatus={{
                    ...baseSetupStatus,
                    hasGatewayConfig: true,
                }}
                onSaveSetup={onSaveSetup}
                onAuthenticate={vi.fn()}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: /Custom gateway/i }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Clear gateway settings" }),
        );

        expect(onSaveSetup).toHaveBeenCalledWith({
            runtimeId: "claude-acp",
            anthropicBaseUrl: "",
            anthropicCustomHeaders: "",
            anthropicAuthToken: "",
        });
    });

    it("shows Gemini-specific auth copy and submits a Gemini API key", () => {
        const onAuthenticate = vi.fn();

        renderComponent(
            <AIChatOnboardingCard
                runtime={{
                    id: "gemini-acp",
                    name: "Gemini ACP",
                    description: "",
                    capabilities: [],
                }}
                setupStatus={{
                    runtimeId: "gemini-acp",
                    binaryReady: true,
                    binarySource: "env",
                    authReady: false,
                    authMethods: [
                        {
                            id: "login_with_google",
                            name: "Log in with Google",
                            description:
                                "Open a Gemini sign-in terminal for Google account authentication.",
                        },
                        {
                            id: "use_gemini",
                            name: "Gemini API key",
                            description:
                                "Use a Gemini Developer API key stored only for VaultAI.",
                        },
                    ],
                    onboardingRequired: true,
                }}
                onSaveSetup={vi.fn()}
                onAuthenticate={onAuthenticate}
            />,
        );

        expect(
            screen.getByText(
                "VaultAI will open a Gemini sign-in terminal inside the app.",
            ),
        ).toBeInTheDocument();

        fireEvent.click(
            screen.getByText("Gemini API key").closest("button") as HTMLElement,
        );
        fireEvent.change(screen.getByPlaceholderText("Gemini API key"), {
            target: { value: "gemini-secret" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Save and continue" }),
        );

        expect(onAuthenticate).toHaveBeenCalledWith({
            runtimeId: "gemini-acp",
            methodId: "use_gemini",
            customBinaryPath: undefined,
            openaiApiKey: undefined,
            codexApiKey: undefined,
            geminiApiKey: "gemini-secret",
            gatewayBaseUrl: undefined,
            gatewayHeaders: undefined,
            anthropicBaseUrl: undefined,
            anthropicCustomHeaders: undefined,
            anthropicAuthToken: undefined,
        });
    });
});
