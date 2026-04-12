import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useChatStore } from "../ai/store/chatStore";
import { SettingsPanel } from "./SettingsPanel";
import { mockInvoke, renderComponent } from "../../test/test-utils";
import { useAppUpdateStore } from "../updates/store";

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
                              "Use an OpenAI API key stored locally in NeverWrite.",
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

function getMockCurrentWindow() {
    return (
        globalThis as typeof globalThis & {
            __mockCurrentWindow: {
                startDragging: { mockClear: () => void };
                toggleMaximize: { mockClear: () => void };
                close: { mockClear: () => void };
            };
        }
    ).__mockCurrentWindow;
}

function getMockCurrentWebviewWindow() {
    return (
        globalThis as typeof globalThis & {
            __mockCurrentWebviewWindow: {
                startDragging: {
                    mockClear: () => void;
                    mock: { calls: unknown[][] };
                };
                toggleMaximize: {
                    mockClear: () => void;
                    mock: { calls: unknown[][] };
                };
                close: {
                    mockClear: () => void;
                    mock: { calls: unknown[][] };
                };
            };
        }
    ).__mockCurrentWebviewWindow;
}

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

beforeEach(() => {
    getMockCurrentWindow().startDragging.mockClear();
    getMockCurrentWindow().toggleMaximize.mockClear();
    getMockCurrentWindow().close.mockClear();
    getMockCurrentWebviewWindow().startDragging.mockClear();
    getMockCurrentWebviewWindow().toggleMaximize.mockClear();
    getMockCurrentWebviewWindow().close.mockClear();
});

afterEach(() => {
    setNavigatorIdentity(originalUserAgent, originalPlatform);
    localStorage.clear();
    mockInvoke().mockReset();
    vi.mocked(getAllWebviewWindows).mockResolvedValue([] as never[]);
    useAppUpdateStore.getState().reset();
});

describe("SettingsPanel", () => {
    it("renders AI providers management inside AI settings", async () => {
        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "AI providers" }));

        expect(await screen.findByText("Installed")).toBeInTheDocument();
        expect(screen.getByText("All")).toBeInTheDocument();
        expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
        expect(screen.getByText("Gemini")).toBeInTheDocument();
        expect(screen.getByText("Kilo")).toBeInTheDocument();
    });

    it("filters recent vaults in a scrollable list", () => {
        localStorage.setItem(
            "neverwrite:recentVaults",
            JSON.stringify([
                {
                    path: "/home/user/projects/NeverWrite",
                    name: "NeverWrite",
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
        expect(screen.getByText("NeverWrite")).toBeInTheDocument();
        expect(screen.getByText("Work 2026")).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "work" } });

        expect(screen.getByText("1/2")).toBeInTheDocument();
        expect(screen.queryByText("NeverWrite")).not.toBeInTheDocument();
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

    it("hides the inline close button in standalone Windows settings", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );
        vi.mocked(listen).mockResolvedValue(vi.fn());

        renderComponent(<SettingsPanel onClose={() => {}} standalone />);

        expect(screen.getByLabelText("Minimize window")).toBeInTheDocument();
        expect(screen.getByLabelText("Maximize window")).toBeInTheDocument();
        expect(screen.getByLabelText("Close window")).toBeInTheDocument();
        expect(
            screen.queryByTitle("Close settings (Esc)"),
        ).not.toBeInTheDocument();
    });

    it("routes standalone Windows chrome actions through the current webview window", () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );
        vi.mocked(listen).mockResolvedValue(vi.fn());

        const mockWindow = getMockCurrentWindow();
        const mockWebviewWindow = getMockCurrentWebviewWindow();

        renderComponent(<SettingsPanel onClose={() => {}} standalone />);

        const chromeRoot = screen
            .getByText("Settings")
            .closest("[data-window-platform]");

        expect(chromeRoot).not.toBeNull();

        fireEvent.mouseDown(chromeRoot!, { button: 0 });
        fireEvent.doubleClick(chromeRoot!);
        fireEvent.click(screen.getByLabelText("Close window"));

        expect(mockWebviewWindow.startDragging.mock.calls).toHaveLength(1);
        expect(mockWebviewWindow.toggleMaximize.mock.calls).toHaveLength(1);
        expect(mockWebviewWindow.close.mock.calls).toHaveLength(1);
        expect(mockWindow.startDragging).not.toHaveBeenCalled();
        expect(mockWindow.toggleMaximize).not.toHaveBeenCalled();
        expect(mockWindow.close).not.toHaveBeenCalled();
    });

    it("keeps the settings window title centered in the shared chrome", () => {
        renderComponent(<SettingsPanel onClose={() => {}} />);

        expect(screen.getByText("Settings")).toHaveStyle({
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
        });
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

    it("groups the font family selector and persists new bundled font options", () => {
        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Editor" }));

        const label = screen.getByText("Font family");
        const row = label.parentElement?.parentElement;
        expect(row).not.toBeNull();

        fireEvent.click(
            within(row as HTMLElement).getByRole("button", {
                name: "System",
            }),
        );

        expect(screen.getByText("Sans")).toBeInTheDocument();
        expect(screen.getByText("Serif")).toBeInTheDocument();
        expect(screen.getByText("Mono")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Inter" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Literata" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "JetBrains Mono" }),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Geist Mono" }));

        expect(useSettingsStore.getState().editorFontFamily).toBe("geist-mono");
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

    it("checks updater metadata manually without starting an install", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "get_app_update_configuration") {
                return {
                    enabled: true,
                    currentVersion: "0.1.0",
                    channel: "stable",
                    endpoint: "https://updates.example.com/stable/latest.json",
                    message: null,
                    update: null,
                };
            }

            if (command === "check_for_app_update") {
                return {
                    enabled: true,
                    currentVersion: "0.1.0",
                    channel: "stable",
                    endpoint: "https://updates.example.com/stable/latest.json",
                    message: null,
                    update: {
                        currentVersion: "0.1.0",
                        version: "0.2.0",
                        date: "2026-04-04T12:00:00Z",
                        body: "## Improvements\n- Added multi-target updater metadata.",
                        rawJson: {},
                        target: "darwin-aarch64",
                        downloadUrl:
                            "https://github.com/example/neverwrite/releases/download/v0.2.0/NeverWrite.app.tar.gz",
                    },
                };
            }

            return undefined;
        });

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Updates" }));

        expect(
            await screen.findByRole("button", { name: "Check for updates" }),
        ).toBeInTheDocument();
        expect(screen.getByText("Update available")).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Check for updates" }),
        );

        expect(await screen.findByText("0.2.0")).toBeInTheDocument();
        expect(
            screen.getByText(/Added multi-target updater metadata\./),
        ).toBeInTheDocument();
    });

    it("requires explicit confirmation before install when sensitive state exists", async () => {
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            { label: "main" },
            { label: "note-1" },
        ] as Awaited<ReturnType<typeof getAllWebviewWindows>>);
        localStorage.setItem(
            "neverwrite:window-operational-state:main",
            JSON.stringify({
                label: "main",
                windowMode: "main",
                windowRole: "main",
                windowTitle: "NeverWrite",
                dirtyTabs: ["Draft note"],
                pendingReviewSessions: ["Refactor updater"],
                activeAgentSessions: ["Release cleanup · Streaming response"],
            }),
        );
        localStorage.setItem(
            "neverwrite:window-operational-state:note-1",
            JSON.stringify({
                label: "note-1",
                windowMode: "note",
                windowRole: "detached-note",
                windowTitle: "Detached note",
                dirtyTabs: [],
                pendingReviewSessions: [],
                activeAgentSessions: [],
            }),
        );
        mockInvoke().mockImplementation(async (command) => {
            if (command === "get_app_update_configuration") {
                return {
                    enabled: true,
                    currentVersion: "0.1.0",
                    channel: "stable",
                    endpoint: "https://updates.example.com/stable/latest.json",
                    message: null,
                    update: null,
                };
            }

            if (command === "check_for_app_update") {
                return {
                    enabled: true,
                    currentVersion: "0.1.0",
                    channel: "stable",
                    endpoint: "https://updates.example.com/stable/latest.json",
                    message: null,
                    update: {
                        currentVersion: "0.1.0",
                        version: "0.2.0",
                        date: "2026-04-04T12:00:00Z",
                        body: "## Added\n\n- In-app install flow.",
                        rawJson: {},
                        target: "darwin-aarch64",
                        downloadUrl:
                            "https://github.com/example/neverwrite/releases/download/v0.2.0/NeverWrite.app.tar.gz",
                    },
                };
            }

            if (command === "download_and_install_app_update") {
                return undefined;
            }

            return undefined;
        });

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Updates" }));

        expect(await screen.findByText("0.2.0")).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Download and install" }),
        );

        expect(
            await screen.findByText("This update may interrupt active work."),
        ).toBeInTheDocument();
        expect(screen.getByText(/Unsaved editor tabs/)).toBeInTheDocument();
        expect(
            screen.getByText(/Pending inline review or agent changes/),
        ).toBeInTheDocument();
        expect(screen.getByText(/Active agent sessions/)).toBeInTheDocument();
        expect(
            screen.getByText(/Separate operational windows are open/),
        ).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", {
                name: "Install anyway",
            }),
        );

        await waitFor(() => {
            expect(mockInvoke()).toHaveBeenCalledWith(
                "download_and_install_app_update",
                {
                    version: "0.2.0",
                    target: "darwin-aarch64",
                },
            );
        });
    });

    it("revalidates sensitive state before starting install", async () => {
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            { label: "main" },
        ] as Awaited<ReturnType<typeof getAllWebviewWindows>>);
        mockInvoke().mockImplementation(async (command) => {
            if (command === "get_app_update_configuration") {
                return {
                    enabled: true,
                    currentVersion: "0.1.0",
                    channel: "stable",
                    endpoint: "https://updates.example.com/stable/latest.json",
                    message: null,
                    update: null,
                };
            }

            if (command === "check_for_app_update") {
                return {
                    enabled: true,
                    currentVersion: "0.1.0",
                    channel: "stable",
                    endpoint: "https://updates.example.com/stable/latest.json",
                    message: null,
                    update: {
                        currentVersion: "0.1.0",
                        version: "0.2.0",
                        date: "2026-04-04T12:00:00Z",
                        body: "## Added\n\n- In-app install flow.",
                        rawJson: {},
                        target: "darwin-aarch64",
                        downloadUrl:
                            "https://github.com/example/neverwrite/releases/download/v0.2.0/NeverWrite.app.tar.gz",
                    },
                };
            }

            if (command === "download_and_install_app_update") {
                return undefined;
            }

            return undefined;
        });

        renderComponent(<SettingsPanel onClose={() => {}} />);

        fireEvent.click(screen.getByRole("button", { name: "Updates" }));

        expect(await screen.findByText("0.2.0")).toBeInTheDocument();

        localStorage.setItem(
            "neverwrite:window-operational-state:main",
            JSON.stringify({
                label: "main",
                windowMode: "main",
                windowRole: "main",
                windowTitle: "NeverWrite",
                dirtyTabs: ["Draft note"],
                pendingReviewSessions: [],
                activeAgentSessions: [],
            }),
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Download and install" }),
        );

        expect(
            await screen.findByText("This update may interrupt active work."),
        ).toBeInTheDocument();
        expect(mockInvoke()).not.toHaveBeenCalledWith(
            "download_and_install_app_update",
            expect.anything(),
        );
    });
});
