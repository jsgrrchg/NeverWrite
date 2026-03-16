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
});
