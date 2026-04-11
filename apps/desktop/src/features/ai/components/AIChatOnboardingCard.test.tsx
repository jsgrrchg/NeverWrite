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
            id: "claude-ai-login",
            name: "Claude subscription",
            description:
                "Open a terminal-based Claude subscription login flow.",
        },
        {
            id: "gateway",
            name: "Custom gateway",
            description:
                "Use a custom Anthropic-compatible gateway just for NeverWrite.",
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
                "NeverWrite will open a limited sign-in terminal for your Claude subscription inside the app.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        ).toBeInTheDocument();
    });

    it("shows the integrated terminal CTA for Kilo login", () => {
        renderComponent(
            <AIChatOnboardingCard
                runtime={{
                    id: "kilo-acp",
                    name: "Kilo",
                    description: "",
                    capabilities: [],
                }}
                setupStatus={{
                    runtimeId: "kilo-acp",
                    binaryReady: true,
                    binarySource: "env",
                    authReady: false,
                    authMethods: [
                        {
                            id: "kilo-login",
                            name: "Kilo login",
                            description:
                                "Open a terminal-based Kilo login flow.",
                        },
                    ],
                    onboardingRequired: true,
                }}
                onSaveSetup={vi.fn()}
                onAuthenticate={vi.fn()}
            />,
        );

        expect(
            screen.getByText(
                "NeverWrite will open a limited Kilo sign-in terminal inside the app.",
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
            codexApiKey: { action: "unchanged" },
            openaiApiKey: { action: "unchanged" },
            geminiApiKey: { action: "unchanged" },
            gatewayHeaders: { action: "unchanged" },
            anthropicCustomHeaders: { action: "unchanged" },
            anthropicAuthToken: { action: "unchanged" },
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
            codexApiKey: { action: "unchanged" },
            openaiApiKey: { action: "unchanged" },
            anthropicBaseUrl: "",
            geminiApiKey: { action: "unchanged" },
            gatewayHeaders: { action: "unchanged" },
            anthropicCustomHeaders: { action: "clear" },
            anthropicAuthToken: { action: "clear" },
        });
    });

    it("can clear an invalid stored gateway configuration", () => {
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
                    hasGatewayConfig: false,
                    hasGatewayUrl: true,
                    message: "HTTP gateways are only allowed for localhost.",
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
            codexApiKey: { action: "unchanged" },
            openaiApiKey: { action: "unchanged" },
            anthropicBaseUrl: "",
            geminiApiKey: { action: "unchanged" },
            gatewayHeaders: { action: "unchanged" },
            anthropicCustomHeaders: { action: "clear" },
            anthropicAuthToken: { action: "clear" },
        });
    });

    it("blocks remote HTTP Claude gateways in the onboarding UI", () => {
        const onAuthenticate = vi.fn();

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
                onAuthenticate={onAuthenticate}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: /Custom gateway/i }),
        );
        fireEvent.change(screen.getByPlaceholderText("Gateway base URL"), {
            target: { value: "http://gateway.example" },
        });

        expect(
            screen.getByText("HTTP gateways are only allowed for localhost."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Save gateway" }),
        ).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Save gateway" }));
        expect(onAuthenticate).not.toHaveBeenCalled();
    });

    it("allows localhost HTTP Claude gateways in the onboarding UI", () => {
        const onAuthenticate = vi.fn();

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
                onAuthenticate={onAuthenticate}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: /Custom gateway/i }),
        );
        fireEvent.change(screen.getByPlaceholderText("Gateway base URL"), {
            target: { value: "http://localhost:3000" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save gateway" }));

        expect(onAuthenticate).toHaveBeenCalledWith({
            runtimeId: "claude-acp",
            methodId: "gateway",
            customBinaryPath: undefined,
            openaiApiKey: { action: "unchanged" },
            codexApiKey: { action: "unchanged" },
            geminiApiKey: { action: "unchanged" },
            gatewayBaseUrl: "http://localhost:3000",
            gatewayHeaders: { action: "unchanged" },
            anthropicBaseUrl: "http://localhost:3000",
            anthropicCustomHeaders: { action: "unchanged" },
            anthropicAuthToken: { action: "unchanged" },
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
                                "Use a Gemini Developer API key stored only for NeverWrite.",
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
                "NeverWrite will open a Gemini sign-in terminal inside the app.",
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
            openaiApiKey: { action: "unchanged" },
            codexApiKey: { action: "unchanged" },
            geminiApiKey: { action: "set", value: "gemini-secret" },
            gatewayBaseUrl: undefined,
            gatewayHeaders: { action: "unchanged" },
            anthropicBaseUrl: undefined,
            anthropicCustomHeaders: { action: "unchanged" },
            anthropicAuthToken: { action: "unchanged" },
        });
    });

    it("can clear a stored API key explicitly from settings", () => {
        const onSaveSetup = vi.fn();

        renderComponent(
            <AIChatOnboardingCard
                runtime={{
                    id: "gemini-acp",
                    name: "Gemini ACP",
                    description: "",
                    capabilities: [],
                }}
                mode="settings"
                setupStatus={{
                    runtimeId: "gemini-acp",
                    binaryReady: true,
                    binarySource: "env",
                    authReady: true,
                    authMethod: "use_gemini",
                    authMethods: [
                        {
                            id: "use_gemini",
                            name: "Gemini API key",
                            description:
                                "Use a Gemini Developer API key stored only for NeverWrite.",
                        },
                    ],
                    onboardingRequired: false,
                }}
                onSaveSetup={onSaveSetup}
                onAuthenticate={vi.fn()}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Clear stored API key" }),
        );

        expect(onSaveSetup).toHaveBeenCalledWith({
            runtimeId: "gemini-acp",
            codexApiKey: { action: "unchanged" },
            openaiApiKey: { action: "unchanged" },
            geminiApiKey: { action: "clear" },
            gatewayHeaders: { action: "unchanged" },
            anthropicCustomHeaders: { action: "unchanged" },
            anthropicAuthToken: { action: "unchanged" },
        });
    });
});
