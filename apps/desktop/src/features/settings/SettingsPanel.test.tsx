import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useChatStore } from "../ai/store/chatStore";
import { SettingsPanel } from "./SettingsPanel";
import { renderComponent } from "../../test/test-utils";

const aiApiMocks = vi.hoisted(() => ({
    aiListRuntimes: vi.fn(async () => [
        {
            runtime: {
                id: "codex-acp",
                name: "Codex ACP",
                description: "",
                capabilities: [],
            },
            models: [],
            modes: [],
            configOptions: [],
        },
        {
            runtime: {
                id: "claude-acp",
                name: "Claude ACP",
                description: "",
                capabilities: [],
            },
            models: [],
            modes: [],
            configOptions: [],
        },
    ]),
    aiGetSetupStatus: vi.fn(async (runtimeId: string) =>
        runtimeId === "claude-acp"
            ? {
                  runtimeId,
                  binaryReady: true,
                  binaryPath: "/tmp/claude-agent-acp",
                  binarySource: "bundled" as const,
                  authReady: false,
                  authMethods: [
                      {
                          id: "claude-login",
                          name: "Claude login",
                          description:
                              "Open a terminal-based Claude login flow.",
                      },
                      {
                          id: "gateway",
                          name: "Custom gateway",
                          description:
                              "Use a custom Anthropic-compatible gateway just for VaultAI.",
                      },
                  ],
                  onboardingRequired: true,
              }
            : {
                  runtimeId,
                  binaryReady: true,
                  binaryPath: "/tmp/codex-acp",
                  binarySource: "bundled" as const,
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
                              "Use an OpenAI API key stored locally in VaultAI.",
                      },
                  ],
                  onboardingRequired: false,
              },
    ),
    aiUpdateSetup: vi.fn(),
    aiStartAuth: vi.fn(),
    aiStartAuthTerminalSession: vi.fn(),
    aiCloseAuthTerminalSession: vi.fn(async () => undefined),
    aiWriteAuthTerminalSession: vi.fn(async () => undefined),
    aiResizeAuthTerminalSession: vi.fn(async () => undefined),
    listenToAiAuthTerminalStarted: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalOutput: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalExited: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalError: vi.fn(async () => vi.fn()),
}));

vi.mock("../ai/api", () => aiApiMocks);

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;

function setNavigatorIdentity(userAgent: string, platform: string) {
    Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: userAgent,
    });
    Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: platform,
    });
}

afterEach(() => {
    setNavigatorIdentity(originalUserAgent, originalPlatform);
    localStorage.clear();
});

describe("SettingsPanel", () => {
    it("renders AI providers management inside AI settings", async () => {
        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI providers" }));

        expect(
            await screen.findByText(
                "Manage runtimes, authentication, and API keys",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("Codex")).toBeInTheDocument();
        expect(screen.getByText("Claude")).toBeInTheDocument();
        expect(
            screen.getByText("These connections apply to VaultAI globally."),
        ).toBeInTheDocument();
    });

    it("filters recent vaults in a scrollable list", () => {
        localStorage.setItem(
            "vaultai:recentVaults",
            JSON.stringify([
                {
                    path: "/home/user/projects/VaultAI",
                    name: "VaultAI",
                },
                {
                    path: "/home/user/notes/Work 2026",
                    name: "Work 2026",
                },
            ]),
        );

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Vault" }));

        const search = screen.getByRole("textbox", {
            name: "Search recent vaults",
        });
        const list = screen.getByRole("list", { name: "Recent vaults" });

        expect(list).toHaveStyle({
            maxHeight: "420px",
            overflowY: "auto",
        });
        expect(screen.getByText("2/2")).toBeInTheDocument();
        expect(screen.getByText("VaultAI")).toBeInTheDocument();
        expect(screen.getByText("Work 2026")).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "work" } });

        expect(screen.getByText("1/2")).toBeInTheDocument();
        expect(screen.queryByText("VaultAI")).not.toBeInTheDocument();
        expect(screen.getByText("Work 2026")).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "missing" } });

        expect(screen.getByText("0/2")).toBeInTheDocument();
        expect(
            screen.getByText("No vaults match your search."),
        ).toBeInTheDocument();
    });

    it("renders the shared shortcut registry labels for Windows", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));

        expect(screen.getByText("Quick Switcher")).toBeInTheDocument();
        expect(screen.getByText("Ctrl+O")).toBeInTheDocument();
        expect(screen.getByText("Open Settings")).toBeInTheDocument();
        expect(screen.getByText("Ctrl+,")).toBeInTheDocument();
    });

    it("renders AI send hints with the platform primary modifier", async () => {
        useChatStore.setState({
            requireCmdEnterToSend: true,
        });

        setNavigatorIdentity(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15",
            "MacIntel",
        );

        const { unmount } = renderComponent(
            <SettingsPanel onClose={() => {}} />,
        );

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        expect(screen.getByText("Require ⌘Enter to send")).toBeInTheDocument();
        expect(
            screen.getByText(/Press ⌘Enter to send messages\./),
        ).toBeInTheDocument();

        unmount();

        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        expect(
            screen.getByText("Require Ctrl+Enter to send"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Press Ctrl\+Enter to send messages\./),
        ).toBeInTheDocument();
    });

    it("renders the screenshot retention control in AI settings", async () => {
        useChatStore.setState({
            screenshotRetentionSeconds: 300,
        });

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        expect(screen.getByText("Screenshot retention")).toBeInTheDocument();
        expect(screen.getByText("5 minutes")).toBeInTheDocument();
        expect(
            screen.getByText(
                "How long pasted screenshots stay in the AI composer before they are removed automatically.",
            ),
        ).toBeInTheDocument();
    });

    it("renders and persists the inline review toggle in AI settings", () => {
        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI" }));

        const label = screen.getByText("Inline review in editor");
        const row = label.parentElement?.parentElement;
        expect(row).not.toBeNull();

        const toggle = within(row as HTMLElement).getByRole("switch");
        expect(toggle).toHaveAttribute("aria-checked", "true");

        fireEvent.click(toggle);

        expect(useSettingsStore.getState().inlineReviewEnabled).toBe(false);
        expect(toggle).toHaveAttribute("aria-checked", "false");
    });
});
