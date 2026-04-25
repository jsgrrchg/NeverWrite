import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import type {
    AIAuthTerminalSessionSnapshot,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
} from "../ai/types";
import { AIProvidersSettings } from "./AIProvidersSettings";

const apiMocks = vi.hoisted(() => ({
    aiGetEnvironmentDiagnostics: vi.fn(),
    aiGetSetupStatus: vi.fn(),
    aiListRuntimes: vi.fn(),
    aiStartAuth: vi.fn(),
    aiUpdateSetup: vi.fn(),
    aiStartAuthTerminalSession: vi.fn(),
    aiCloseAuthTerminalSession: vi.fn(async () => undefined),
    aiWriteAuthTerminalSession: vi.fn(async () => undefined),
    aiResizeAuthTerminalSession: vi.fn(),
    listenToAiAuthTerminalStarted: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalOutput: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalExited: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalError: vi.fn(async () => vi.fn()),
}));

vi.mock("../ai/api", () => apiMocks);

function createRuntimeDescriptor(
    id: string,
    name: string,
): AIRuntimeDescriptor {
    return {
        runtime: {
            id,
            name,
            description: "",
            capabilities: [],
        },
        models: [],
        modes: [],
        configOptions: [],
    };
}

function createSetupStatus(
    input: Partial<AIRuntimeSetupStatus> & Pick<AIRuntimeSetupStatus, "runtimeId">,
): AIRuntimeSetupStatus {
    return {
        binaryReady: true,
        binaryPath: `/tmp/${input.runtimeId}`,
        binarySource: "bundled",
        authReady: false,
        authMethods: [],
        onboardingRequired: true,
        ...input,
    };
}

function createTerminalSnapshot(
    runtimeId: string,
): AIAuthTerminalSessionSnapshot {
    return {
        sessionId: `authterm-${runtimeId}`,
        runtimeId,
        program: runtimeId,
        displayName: `${runtimeId} sign-in`,
        cwd: "",
        cols: 100,
        rows: 28,
        buffer: "Ready",
        status: "running",
        exitCode: null,
        errorMessage: null,
    };
}

function createDefaultProviders() {
    const descriptors = [
        createRuntimeDescriptor("codex-acp", "Codex ACP"),
        createRuntimeDescriptor("claude-acp", "Claude ACP"),
    ];

    const statuses: Record<string, AIRuntimeSetupStatus> = {
        "codex-acp": createSetupStatus({
            runtimeId: "codex-acp",
            authReady: true,
            authMethod: "openai-api-key",
            authMethods: [
                {
                    id: "chatgpt",
                    name: "ChatGPT account",
                    description:
                        "Sign in with your paid ChatGPT account to connect Codex.",
                },
                {
                    id: "openai-api-key",
                    name: "API key",
                    description:
                        "Use an OpenAI API key stored locally in NeverWrite.",
                },
            ],
            onboardingRequired: false,
        }),
        "claude-acp": createSetupStatus({
            runtimeId: "claude-acp",
            authMethods: [
                {
                    id: "claude-ai-login",
                    name: "Claude subscription",
                    description:
                        "Open a terminal-based Claude subscription login flow.",
                },
                {
                    id: "console-login",
                    name: "Anthropic Console",
                    description:
                        "Open a terminal-based Anthropic Console login flow.",
                },
                {
                    id: "gateway",
                    name: "Custom gateway",
                    description:
                        "Use a custom Anthropic-compatible gateway just for NeverWrite.",
                },
            ],
        }),
    };

    return { descriptors, statuses };
}

function mockProviders({
    descriptors,
    statuses,
}: {
    descriptors: AIRuntimeDescriptor[];
    statuses: Record<string, AIRuntimeSetupStatus>;
}) {
    apiMocks.aiListRuntimes.mockResolvedValue(descriptors);
    apiMocks.aiGetSetupStatus.mockImplementation(async (runtimeId: string) => {
        const status = statuses[runtimeId];
        if (!status) {
            throw new Error(`Unexpected runtime ${runtimeId}`);
        }
        return status;
    });
    apiMocks.aiUpdateSetup.mockImplementation(
        async (input: { runtimeId: string }) =>
            statuses[input.runtimeId] ??
            createSetupStatus({ runtimeId: input.runtimeId }),
    );
    apiMocks.aiStartAuth.mockImplementation(
        async (input: { runtimeId: string; methodId: string }) => ({
            ...(statuses[input.runtimeId] ??
                createSetupStatus({ runtimeId: input.runtimeId })),
            authReady: true,
            authMethod: input.methodId,
            onboardingRequired: false,
        }),
    );
    apiMocks.aiStartAuthTerminalSession.mockImplementation(
        async (input: { runtimeId: string }) =>
            createTerminalSnapshot(input.runtimeId),
    );
    apiMocks.aiResizeAuthTerminalSession.mockImplementation(
        async (input: { sessionId: string; cols: number; rows: number }) => ({
            ...createTerminalSnapshot("claude-acp"),
            sessionId: input.sessionId,
            cols: input.cols,
            rows: input.rows,
        }),
    );
    apiMocks.aiCloseAuthTerminalSession.mockResolvedValue(undefined);
    apiMocks.aiWriteAuthTerminalSession.mockResolvedValue(undefined);
    apiMocks.listenToAiAuthTerminalStarted.mockResolvedValue(vi.fn());
    apiMocks.listenToAiAuthTerminalOutput.mockResolvedValue(vi.fn());
    apiMocks.listenToAiAuthTerminalExited.mockResolvedValue(vi.fn());
    apiMocks.listenToAiAuthTerminalError.mockResolvedValue(vi.fn());
}

function getButtonFromText(text: string) {
    const button = screen
        .getAllByText(text)
        .map((label) => label.closest("button"))
        .find(
            (candidate): candidate is HTMLButtonElement => candidate != null,
        );
    if (!button) {
        throw new Error(`No button found for ${text}`);
    }
    return button;
}

async function openProvider(providerName: string) {
    await screen.findByText(providerName);
    const providerButton = screen
        .getAllByRole("button")
        .find((candidate) => candidate.textContent?.includes(providerName));
    if (!providerButton) {
        throw new Error(`No provider row found for ${providerName}`);
    }
    fireEvent.click(providerButton);
}

describe("AIProvidersSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockProviders(createDefaultProviders());
    });

    it("validates Claude gateway URLs before saving provider authentication", async () => {
        renderComponent(<AIProvidersSettings />);

        await openProvider("Claude");
        fireEvent.click(getButtonFromText("Custom gateway"));

        fireEvent.change(screen.getByPlaceholderText("Gateway base URL"), {
            target: { value: "http://gateway.example" },
        });

        expect(
            screen.getByText("HTTP gateways are only allowed for localhost."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Save gateway" }),
        ).toBeDisabled();
        expect(apiMocks.aiUpdateSetup).not.toHaveBeenCalled();

        fireEvent.change(screen.getByPlaceholderText("Gateway base URL"), {
            target: { value: "http://localhost:3000" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save gateway" }));

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "claude-acp",
                    anthropicBaseUrl: "http://localhost:3000",
                    anthropicCustomHeaders: { action: "unchanged" },
                    anthropicAuthToken: { action: "unchanged" },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "gateway", runtimeId: "claude-acp" },
            null,
        );
    });

    it("clears stored Claude gateway settings from the live provider settings", async () => {
        const providers = createDefaultProviders();
        providers.statuses["claude-acp"] = {
            ...providers.statuses["claude-acp"],
            hasGatewayConfig: true,
        };
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Claude");
        fireEvent.click(getButtonFromText("Custom gateway"));
        fireEvent.click(
            screen.getByRole("button", { name: "Clear gateway settings" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "claude-acp",
                    anthropicBaseUrl: "",
                    anthropicCustomHeaders: { action: "clear" },
                    anthropicAuthToken: { action: "clear" },
                }),
            );
        });
    });

    it("submits Gemini API keys through provider settings", async () => {
        const providers = createDefaultProviders();
        providers.descriptors.push(
            createRuntimeDescriptor("gemini-acp", "Gemini ACP"),
        );
        providers.statuses["gemini-acp"] = createSetupStatus({
            runtimeId: "gemini-acp",
            binarySource: "env",
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
        });
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Gemini");
        fireEvent.click(getButtonFromText("Gemini API key"));
        fireEvent.change(screen.getByPlaceholderText("Gemini API key"), {
            target: { value: "gemini-secret" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "gemini-acp",
                    geminiApiKey: {
                        action: "set",
                        value: "gemini-secret",
                    },
                    anthropicBaseUrl: undefined,
                    anthropicCustomHeaders: { action: "unchanged" },
                    anthropicAuthToken: { action: "unchanged" },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "use_gemini", runtimeId: "gemini-acp" },
            null,
        );
    });

    it("expands a provider row even when setup status failed to load", async () => {
        const providers = createDefaultProviders();
        apiMocks.aiListRuntimes.mockResolvedValue(providers.descriptors);
        apiMocks.aiGetSetupStatus.mockImplementation(async (runtimeId: string) => {
            if (runtimeId === "codex-acp") return providers.statuses[runtimeId];
            throw new Error("Native backend is unavailable.");
        });

        renderComponent(<AIProvidersSettings />);

        await openProvider("Claude");

        expect(
            await screen.findByText("Native backend is unavailable."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
    });

    it("opens integrated terminal auth for Kilo providers", async () => {
        const providers = createDefaultProviders();
        providers.descriptors.push(
            createRuntimeDescriptor("kilo-acp", "Kilo ACP"),
        );
        providers.statuses["kilo-acp"] = createSetupStatus({
            runtimeId: "kilo-acp",
            binarySource: "env",
            authMethods: [
                {
                    id: "kilo-login",
                    name: "Kilo login",
                    description: "Open a terminal-based Kilo login flow.",
                },
            ],
        });
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Kilo");
        fireEvent.click(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiStartAuthTerminalSession).toHaveBeenCalledWith({
                runtimeId: "kilo-acp",
                methodId: "kilo-login",
                vaultPath: null,
                customBinaryPath: undefined,
            });
        });
    });
});
