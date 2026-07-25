import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import type {
    AIAuthTerminalSessionSnapshot,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
} from "../ai/types";
import { AIProvidersSettings } from "./AIProvidersSettings";
import { createSettingsSearchQuery } from "./settingsSearch";

const apiMocks = vi.hoisted(() => ({
    aiGetEnvironmentDiagnostics: vi.fn(),
    aiGetSetupStatus: vi.fn(),
    aiListRuntimes: vi.fn(),
    aiLogout: vi.fn(),
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
    input: Partial<AIRuntimeSetupStatus> &
        Pick<AIRuntimeSetupStatus, "runtimeId">,
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
                    id: "anthropic-api-key",
                    name: "Anthropic API key",
                    description: "Use an Anthropic API key stored locally.",
                },
                {
                    id: "gateway",
                    name: "Custom gateway",
                    description:
                        "Use a custom Anthropic-compatible gateway just for NeverWrite.",
                },
                {
                    id: "gateway-bedrock",
                    name: "Bedrock gateway",
                    description:
                        "Use a custom Bedrock-compatible gateway just for NeverWrite.",
                },
            ],
        }),
    };

    return { descriptors, statuses };
}

function addOpenCodeProvider(
    providers: ReturnType<typeof createDefaultProviders>,
    statusOverrides: Partial<AIRuntimeSetupStatus> = {},
) {
    providers.descriptors.push(
        createRuntimeDescriptor("opencode-acp", "OpenCode ACP"),
    );
    providers.statuses["opencode-acp"] = createSetupStatus({
        runtimeId: "opencode-acp",
        binarySource: "env",
        authMethods: [
            {
                id: "opencode-login",
                name: "OpenCode auth",
                description:
                    "Use providers and credentials configured by the OpenCode CLI.",
            },
        ],
        ...statusOverrides,
    });
}

function addGrokProvider(
    providers: ReturnType<typeof createDefaultProviders>,
    statusOverrides: Partial<AIRuntimeSetupStatus> = {},
) {
    providers.descriptors.push(createRuntimeDescriptor("grok-acp", "Grok ACP"));
    providers.statuses["grok-acp"] = createSetupStatus({
        runtimeId: "grok-acp",
        binarySource: "env",
        authMethods: [
            {
                id: "grok-login",
                name: "Grok login",
                description: "Open a terminal-based Grok login flow.",
            },
            {
                id: "xai-api-key",
                name: "xAI API key",
                description: "Use an xAI API key stored only for NeverWrite.",
            },
        ],
        ...statusOverrides,
    });
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
    apiMocks.aiLogout.mockImplementation(async (input: { runtimeId: string }) => ({
        ...(statuses[input.runtimeId] ??
            createSetupStatus({ runtimeId: input.runtimeId })),
        authReady: false,
        authMethod: undefined,
        onboardingRequired: true,
    }));
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
        .find((candidate): candidate is HTMLButtonElement => candidate != null);
    if (!button) {
        throw new Error(`No button found for ${text}`);
    }
    return button;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

async function openProvider(providerName: string) {
    await screen.findAllByText(providerName);
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

    it("does not offer provider installs while runtime inventory is still loading", async () => {
        const deferredRuntimes = createDeferred<AIRuntimeDescriptor[]>();
        apiMocks.aiListRuntimes.mockReturnValue(deferredRuntimes.promise);

        renderComponent(<AIProvidersSettings />);

        expect(
            await screen.findByText("Loading providers…"),
        ).toBeInTheDocument();
        expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
        expect(
            screen.queryByRole("button", { name: "Install" }),
        ).not.toBeInTheDocument();

        deferredRuntimes.resolve(createDefaultProviders().descriptors);
    });

    it("does not show Gemini when the backend runtime catalog omits it", async () => {
        renderComponent(<AIProvidersSettings />);

        expect(await screen.findByText("Codex")).toBeInTheDocument();
        expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
        expect(screen.queryByText("Gemini")).not.toBeInTheDocument();
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

    it("submits Claude Bedrock gateway settings through provider settings", async () => {
        renderComponent(<AIProvidersSettings />);

        await openProvider("Claude");
        fireEvent.click(getButtonFromText("Bedrock gateway"));

        fireEvent.change(screen.getByPlaceholderText("Gateway base URL"), {
            target: { value: "https://bedrock-gateway.example" },
        });
        fireEvent.change(
            screen.getByPlaceholderText(/Headers, one per line/),
            {
                target: { value: "x-api-key: bedrock-secret" },
            },
        );

        expect(
            screen.queryByPlaceholderText("Auth token (optional)"),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Save gateway" }));

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "claude-acp",
                    anthropicBaseUrl: undefined,
                    anthropicBedrockBaseUrl: "https://bedrock-gateway.example",
                    anthropicCustomHeaders: {
                        action: "set",
                        value: "x-api-key: bedrock-secret",
                    },
                    anthropicAuthToken: { action: "unchanged" },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "gateway-bedrock", runtimeId: "claude-acp" },
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
                    anthropicBedrockBaseUrl: "",
                    anthropicCustomHeaders: { action: "clear" },
                    anthropicAuthToken: { action: "clear" },
                }),
            );
        });
    });

    it("submits Anthropic API keys through provider settings", async () => {
        renderComponent(<AIProvidersSettings />);

        await openProvider("Claude");
        fireEvent.click(getButtonFromText("Anthropic API key"));
        fireEvent.change(screen.getByPlaceholderText("Anthropic API key"), {
            target: { value: "anthropic-secret" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Save and connect" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "claude-acp",
                    anthropicApiKey: {
                        action: "set",
                        value: "anthropic-secret",
                    },
                    anthropicBaseUrl: undefined,
                    anthropicCustomHeaders: { action: "unchanged" },
                    anthropicAuthToken: { action: "unchanged" },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "anthropic-api-key", runtimeId: "claude-acp" },
            null,
        );
    });

    it("saves Google Vertex AI routing without starting Claude authentication", async () => {
        renderComponent(<AIProvidersSettings />);

        await openProvider("Claude");
        fireEvent.click(getButtonFromText("Google Vertex AI"));

        expect(
            screen.getByText(
                "Authentication is provided by Google Application Default Credentials.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Changes apply to new or reopened sessions. Active chats keep their current provider configuration.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByPlaceholderText(/Vertex API key/i)).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Vertex endpoint"), {
            target: { value: "http://vertex.example" },
        });
        expect(
            screen.getByText("HTTP gateways are only allowed for localhost."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Save Vertex configuration" }),
        ).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Vertex endpoint"), {
            target: { value: "https://vertex.example" },
        });
        expect(screen.getByText("Project ID is required.")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Project ID"), {
            target: { value: "project-1" },
        });
        expect(screen.getByText("Region is required.")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Region"), {
            target: { value: "us-east5" },
        });
        fireEvent.change(screen.getByLabelText("Custom headers (optional)"), {
            target: { value: "x-api-key: gateway-secret" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Save Vertex configuration" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "claude-acp",
                    claudeProviderRouting: {
                        type: "vertex",
                        baseUrl: "https://vertex.example",
                        projectId: "project-1",
                        region: "us-east5",
                    },
                    anthropicCustomHeaders: {
                        action: "set",
                        value: "x-api-key: gateway-secret",
                    },
                    anthropicApiKey: { action: "unchanged" },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).not.toHaveBeenCalled();
        expect(apiMocks.aiLogout).not.toHaveBeenCalled();
    });

    it("clears Vertex routing without deleting existing Claude authentication", async () => {
        const providers = createDefaultProviders();
        providers.statuses["claude-acp"] = {
            ...providers.statuses["claude-acp"],
            authReady: true,
            authMethod: "anthropic-api-key",
            onboardingRequired: false,
            claudeProviderRouting: {
                type: "vertex",
                baseUrl: "https://vertex.example",
                projectId: "project-1",
                region: "us-east5",
            },
        };
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);
        await openProvider("Claude");

        expect(screen.getByLabelText("Vertex endpoint")).toHaveValue(
            "https://vertex.example",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Clear Vertex settings" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "claude-acp",
                    claudeProviderRouting: { type: "default" },
                    anthropicApiKey: { action: "unchanged" },
                    anthropicCustomHeaders: { action: "unchanged" },
                    anthropicAuthToken: { action: "unchanged" },
                }),
            );
        });
        expect(apiMocks.aiLogout).not.toHaveBeenCalled();
        expect(apiMocks.aiStartAuth).not.toHaveBeenCalled();
    });

    it("returns from Vertex routing when an Anthropic API key is selected", async () => {
        const providers = createDefaultProviders();
        providers.statuses["claude-acp"] = {
            ...providers.statuses["claude-acp"],
            claudeProviderRouting: {
                type: "vertex",
                baseUrl: "https://vertex.example",
                projectId: "project-1",
                region: "us-east5",
            },
        };
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);
        await openProvider("Claude");
        fireEvent.click(getButtonFromText("Anthropic API key"));
        fireEvent.change(screen.getByPlaceholderText("Anthropic API key"), {
            target: { value: "anthropic-secret" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Save and connect" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    claudeProviderRouting: { type: "default" },
                    anthropicApiKey: {
                        action: "set",
                        value: "anthropic-secret",
                    },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "anthropic-api-key", runtimeId: "claude-acp" },
            null,
        );
    });

    it("logs providers out through the native backend logout command", async () => {
        renderComponent(<AIProvidersSettings />);

        await openProvider("Codex");
        fireEvent.click(screen.getByRole("button", { name: "Log Out" }));

        await waitFor(() => {
            expect(apiMocks.aiLogout).toHaveBeenCalledWith({
                runtimeId: "codex-acp",
                vaultPath: null,
            });
        });
        expect(apiMocks.aiUpdateSetup).not.toHaveBeenCalledWith(
            expect.objectContaining({
                runtimeId: "codex-acp",
                codexApiKey: { action: "clear" },
                openaiApiKey: { action: "clear" },
            }),
        );
    });

    it("submits Kilo API keys without opening terminal auth", async () => {
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
                {
                    id: "kilo-api-key",
                    name: "Kilo API key",
                    description: "Use a Kilo API key stored only for NeverWrite.",
                },
            ],
        });
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Kilo");
        fireEvent.click(getButtonFromText("Kilo API key"));
        fireEvent.change(screen.getByPlaceholderText("Kilo API key"), {
            target: { value: "kilo-secret" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Save and connect" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "kilo-acp",
                    kiloApiKey: {
                        action: "set",
                        value: "kilo-secret",
                    },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "kilo-api-key", runtimeId: "kilo-acp" },
            null,
        );
        expect(apiMocks.aiStartAuthTerminalSession).not.toHaveBeenCalled();
    });

    it("submits Grok xAI API keys without opening terminal auth", async () => {
        const providers = createDefaultProviders();
        addGrokProvider(providers);
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Grok");
        fireEvent.click(getButtonFromText("xAI API key"));
        fireEvent.change(screen.getByPlaceholderText("xAI API key"), {
            target: { value: "xai-secret" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Save and connect" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "grok-acp",
                    xaiApiKey: {
                        action: "set",
                        value: "xai-secret",
                    },
                }),
            );
        });
        expect(apiMocks.aiStartAuth).toHaveBeenCalledWith(
            { methodId: "xai-api-key", runtimeId: "grok-acp" },
            null,
        );
        expect(apiMocks.aiStartAuthTerminalSession).not.toHaveBeenCalled();
    });

    it("expands a provider row even when setup status failed to load", async () => {
        const providers = createDefaultProviders();
        apiMocks.aiListRuntimes.mockResolvedValue(providers.descriptors);
        apiMocks.aiGetSetupStatus.mockImplementation(
            async (runtimeId: string) => {
                if (runtimeId === "codex-acp")
                    return providers.statuses[runtimeId];
                throw new Error("Native backend is unavailable.");
            },
        );

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

    it("opens integrated terminal auth for Grok providers", async () => {
        const providers = createDefaultProviders();
        addGrokProvider(providers);
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Grok");
        fireEvent.click(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiStartAuthTerminalSession).toHaveBeenCalledWith({
                runtimeId: "grok-acp",
                methodId: "grok-login",
                vaultPath: null,
                customBinaryPath: undefined,
            });
        });
    });

    it("preflights a Grok custom binary path before opening terminal auth", async () => {
        const providers = createDefaultProviders();
        addGrokProvider(providers);
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("Grok");
        fireEvent.change(screen.getByLabelText("Runtime binary"), {
            target: { value: "/Users/jfg/.grok/bin/grok" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "grok-acp",
                    customBinaryPath: "/Users/jfg/.grok/bin/grok",
                    xaiApiKey: { action: "unchanged" },
                    kiloApiKey: { action: "unchanged" },
                    anthropicApiKey: { action: "unchanged" },
                }),
            );
            expect(apiMocks.aiStartAuthTerminalSession).toHaveBeenCalledWith({
                runtimeId: "grok-acp",
                methodId: "grok-login",
                vaultPath: null,
                customBinaryPath: "/Users/jfg/.grok/bin/grok",
            });
        });

        expect(
            apiMocks.aiUpdateSetup.mock.invocationCallOrder[0],
        ).toBeLessThan(
            apiMocks.aiStartAuthTerminalSession.mock.invocationCallOrder[0],
        );
    });

    it("finds Grok providers by xAI runtime setup search values", async () => {
        mockProviders(createDefaultProviders());

        renderComponent(
            <AIProvidersSettings
                searchQuery={createSettingsSearchQuery(
                    "NEVERWRITE_GROK_ACP_BIN",
                )}
            />,
        );

        expect((await screen.findAllByText("Grok")).length).toBeGreaterThan(0);
        expect(screen.queryByText("OpenCode")).not.toBeInTheDocument();
    });

    it("lists OpenCode in the provider catalog before it is installed", async () => {
        renderComponent(<AIProvidersSettings />);

        expect((await screen.findAllByText("OpenCode")).length).toBeGreaterThan(
            0,
        );
    });

    it("opens integrated terminal auth for OpenCode without treating it as an API key", async () => {
        const providers = createDefaultProviders();
        addOpenCodeProvider(providers);
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("OpenCode");

        expect(screen.getByText("OpenCode auth")).toBeInTheDocument();
        expect(
            screen.getByText(
                "Use providers and credentials configured by the OpenCode CLI.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("API key")).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiStartAuthTerminalSession).toHaveBeenCalledWith({
                runtimeId: "opencode-acp",
                methodId: "opencode-login",
                vaultPath: null,
                customBinaryPath: undefined,
            });
        });
        expect(apiMocks.aiStartAuth).not.toHaveBeenCalledWith(
            { methodId: "opencode-login", runtimeId: "opencode-acp" },
            null,
        );
    });

    it("preflights an OpenCode custom binary path before opening terminal auth", async () => {
        const providers = createDefaultProviders();
        addOpenCodeProvider(providers);
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("OpenCode");
        fireEvent.change(screen.getByLabelText("Runtime binary"), {
            target: { value: "/usr/local/bin/opencode" },
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        );

        await waitFor(() => {
            expect(apiMocks.aiUpdateSetup).toHaveBeenCalledWith(
                expect.objectContaining({
                    runtimeId: "opencode-acp",
                    customBinaryPath: "/usr/local/bin/opencode",
                    codexApiKey: { action: "unchanged" },
                    openaiApiKey: { action: "unchanged" },
                    kiloApiKey: { action: "unchanged" },
                    anthropicApiKey: { action: "unchanged" },
                }),
            );
            expect(apiMocks.aiStartAuthTerminalSession).toHaveBeenCalledWith({
                runtimeId: "opencode-acp",
                methodId: "opencode-login",
                vaultPath: null,
                customBinaryPath: "/usr/local/bin/opencode",
            });
        });

        expect(
            apiMocks.aiUpdateSetup.mock.invocationCallOrder[0],
        ).toBeLessThan(
            apiMocks.aiStartAuthTerminalSession.mock.invocationCallOrder[0],
        );
    });

    it("labels connected OpenCode auth as a local disconnect action", async () => {
        const providers = createDefaultProviders();
        addOpenCodeProvider(providers, {
            authReady: true,
            authMethod: "opencode-login",
            onboardingRequired: false,
        });
        mockProviders(providers);

        renderComponent(<AIProvidersSettings />);

        await openProvider("OpenCode");
        fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

        await waitFor(() => {
            expect(apiMocks.aiLogout).toHaveBeenCalledWith({
                runtimeId: "opencode-acp",
                vaultPath: null,
            });
        });
    });
});
