import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@neverwrite/runtime";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type {
    AIChatSession,
    DraftAttachmentId,
} from "../types";
import {
    MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
    MAX_IMAGE_ATTACHMENT_BYTES,
} from "../imageAttachments";
import { AIChatSessionView } from "./AIChatSessionView";
import { AI_CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";

const composerMockState = vi.hoisted(() => ({
    onPasteImage: undefined as ((file: File) => void) | undefined,
    onSubmit: undefined as (() => void) | undefined,
}));
const agentControlsMockState = vi.hoisted(() => ({
    props: null as null | {
        runtimeId?: string;
        providerSwitchLocked?: boolean;
        providers?: Array<{
            runtimeId: string;
            disabledReason: string | null;
        }>;
        onProviderModelChange?: (runtimeId: string, modelId: string) => void;
    },
}));
const messageListMockState = vi.hoisted(() => ({
    props: [] as Array<{
        bottomInset?: number;
        sessionId?: string | null;
        scrollToMessageId?: string | null;
        onScrollToMessageComplete?: () => void;
    }>,
}));

const invokeMock = vi.mocked(invoke);

vi.mock("./AIChatMessageList", () => ({
    AIChatMessageList: (props: {
        bottomInset?: number;
        sessionId?: string | null;
        scrollToMessageId?: string | null;
        onScrollToMessageComplete?: () => void;
    }) => {
        messageListMockState.props.push(props);
        return (
            <div
                data-testid="chat-message-list"
                data-scroll-to-message-id={props.scrollToMessageId ?? ""}
            />
        );
    },
}));

vi.mock("./AIChatComposer", () => ({
    AIChatComposer: ({
        disabled,
        expanded,
        contextBar,
        footer,
        onToggleExpanded,
        onPasteImage,
        onSubmit,
        placeholderText,
    }: {
        disabled?: boolean;
        expanded?: boolean;
        contextBar?: ReactNode;
        footer?: ReactNode;
        onToggleExpanded?: () => void;
        onPasteImage?: (file: File) => void;
        onSubmit?: () => void;
        placeholderText?: string;
    }) => {
        composerMockState.onSubmit = onSubmit;
        return <div>
            <button
                type="button"
                data-testid="chat-composer"
                data-disabled={String(Boolean(disabled))}
                data-expanded={String(Boolean(expanded))}
                onClick={onToggleExpanded}
            >
                {placeholderText}
            </button>
            {contextBar}
            <div data-testid="chat-composer-footer">{footer}</div>
            <button
                type="button"
                data-testid="paste-image"
                onClick={() => {
                    composerMockState.onPasteImage = onPasteImage;
                }}
            />
        </div>;
    },
}));

vi.mock("./AIChatContextBar", () => ({
    AIChatContextBar: () => <div data-testid="chat-context-bar" />,
}));

vi.mock("./AIChatAgentControls", () => ({
    AIChatAgentControls: (
        props: NonNullable<typeof agentControlsMockState.props>,
    ) => {
        agentControlsMockState.props = props;
        return <div data-testid="chat-agent-controls" />;
    },
}));

vi.mock("./EditedFilesBufferPanel", () => ({
    EditedFilesBufferPanel: () => <div data-testid="edited-files-panel" />,
}));

vi.mock("./QueuedMessagesPanel", () => ({
    QueuedMessagesPanel: () => <div data-testid="queued-messages-panel" />,
}));

vi.mock("./AIChatRuntimeBanner", () => ({
    AIChatRuntimeBanner: () => <div data-testid="chat-runtime-banner" />,
}));

function createSession(sessionId: string, title: string): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}-message`,
                role: "user",
                kind: "text",
                content: title,
                timestamp: 10,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        runtimeState: "live",
    };
}

function setupWorkspaceSession(sessionId = "session-a") {
    useChatStore.setState((state) => ({
        ...state,
        sessionsById: {
            [sessionId]: createSession(sessionId, "Workspace chat"),
        },
        activeSessionId: sessionId,
    }));
    useEditorStore.getState().openChat(sessionId, {
        title: "Workspace chat",
        paneId: "primary",
    });
}

function expectColumnAncestor(testId: string) {
    const element = screen.getByTestId(testId);
    const column = element.closest('[data-testid="chat-content-column"]');

    expect(column).not.toBeNull();
    expect(column).toHaveStyle({
        width: "100%",
        maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
        marginInline: "auto",
    });

    return column as HTMLElement;
}

describe("AIChatSessionView", () => {
    beforeEach(() => {
        resetChatStore();
        useSettingsStore.getState().reset();
        composerMockState.onPasteImage = undefined;
        composerMockState.onSubmit = undefined;
        agentControlsMockState.props = null;
        messageListMockState.props = [];
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
        });
    });

    it("locks provider changes after the conversation starts", () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            runtimes: [
                ...state.runtimes,
                {
                    runtime: {
                        id: "provider-b",
                        name: "Provider B ACP",
                        description: "Second provider",
                        capabilities: ["create_session"],
                    },
                    models: [
                        {
                            id: "model-b",
                            runtimeId: "provider-b",
                            name: "Model B",
                            description: "Provider B model",
                        },
                    ],
                    modes: [],
                    configOptions: [],
                },
            ],
            setupStatusByRuntimeId: {
                ...state.setupStatusByRuntimeId,
                "provider-b": {
                    runtimeId: "provider-b",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: true,
                    authMethods: [],
                    onboardingRequired: false,
                },
            },
        }));
        renderComponent(<AIChatSessionView paneId="primary" />);
        expect(
            agentControlsMockState.props?.providers?.map(
                (provider) => provider.runtimeId,
            ),
        ).toContain("provider-b");
        expect(
            agentControlsMockState.props?.providerSwitchLocked,
        ).toBe(true);

        act(() => {
            agentControlsMockState.props?.onProviderModelChange?.(
                "provider-b",
                "model-b",
            );
        });

        expect(
            useChatStore.getState().conversationsById["session-a"]
                ?.preferredSelection,
        ).toMatchObject({
            runtimeId: "codex-acp",
            modelId: "test-model",
        });
    });

    it("renames the workspace chat from the local header title on double click", async () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.doubleClick(screen.getByText("Workspace chat"));

        const input = screen.getByDisplayValue("Workspace chat");
        fireEvent.change(input, {
            target: { value: "Renamed workspace chat" },
        });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["session-a"]?.customTitle,
            ).toBe("Renamed workspace chat");
        });

        expect(screen.getByText("Renamed workspace chat")).toBeInTheDocument();
    });

    it("blocks the composer for saved Gemini ACP chats", () => {
        const sessionId = "persisted:gemini-history";
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [sessionId]: {
                    ...createSession(sessionId, "Gemini history"),
                    runtimeId: "gemini-acp",
                    runtimeState: "persisted_only",
                    isPersistedSession: true,
                },
            },
            activeSessionId: sessionId,
        }));
        useEditorStore.getState().openChat(sessionId, {
            title: "Gemini history",
            paneId: "primary",
        });

        renderComponent(<AIChatSessionView paneId="primary" />);

        expect(screen.getByTestId("chat-composer")).toHaveAttribute(
            "data-disabled",
            "true",
        );
        expect(
            screen.getByText("Gemini ACP is no longer supported by Google."),
        ).toBeInTheDocument();
    });

    it("removes expired screenshots from the composer", async () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": createSession("session-a", "Workspace chat"),
            },
            activeSessionId: "session-a",
            screenshotRetentionSeconds: 60,
            composerPartsBySessionId: {
                "session-a": [
                    { id: "text-1", type: "text", text: "Review " },
                    {
                        id: "shot-1",
                        type: "screenshot",
                        draftAttachmentId:
                            "da_0123456789abcdef0123456789abcdef" as DraftAttachmentId,
                        fileName: "old.png",
                        mimeType: "image/png",
                        label: "Screenshot 10:42 hrs",
                        createdAt: Date.now() - 61_000,
                    },
                    { id: "text-2", type: "text", text: " please" },
                ],
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        await waitFor(() => {
            expect(
                useChatStore.getState().composerPartsBySessionId["session-a"],
            ).toEqual([{ id: "text-1", type: "text", text: "Review  please" }]);
        });
        expect(invokeMock).toHaveBeenCalledWith(
            "ai_delete_draft_attachment",
            expect.objectContaining({
                vaultPath: "/vault",
                draftAttachmentId:
                    "da_0123456789abcdef0123456789abcdef",
            }),
        );
    });

    it("keeps sent timeline image attachments when composer screenshots expire", async () => {
        setupWorkspaceSession();
        const sentAttachments = [
            {
                id: "sent-image",
                type: "file" as const,
                noteId: null,
                label: "old.png",
                path: null,
                filePath: "/vault/assets/chat/old.png",
                mimeType: "image/png",
            },
        ];

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": {
                    ...createSession("session-a", "Workspace chat"),
                    messages: [
                        {
                            id: "sent-message",
                            role: "user",
                            kind: "text",
                            content: "See attached image",
                            timestamp: 10,
                            attachments: sentAttachments,
                        },
                    ],
                },
            },
            activeSessionId: "session-a",
            screenshotRetentionSeconds: 60,
            composerPartsBySessionId: {
                "session-a": [
                    {
                        id: "draft-shot",
                        type: "screenshot",
                        filePath: "/vault/assets/chat/draft-old.png",
                        mimeType: "image/png",
                        label: "Screenshot 10:42 hrs",
                        createdAt: Date.now() - 61_000,
                    },
                ],
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        await waitFor(() => {
            expect(
                useChatStore.getState().composerPartsBySessionId["session-a"],
            ).toHaveLength(1);
            expect(
                useChatStore.getState().composerPartsBySessionId["session-a"]?.some(
                    (part) => part.type === "screenshot",
                ),
            ).toBe(false);
        });
        expect(
            useChatStore.getState().sessionsById["session-a"]?.messages[0]
                ?.attachments,
        ).toEqual(sentAttachments);
    });

    it("aligns lower chat panels to the shared content column", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        expectColumnAncestor("edited-files-panel");
        expectColumnAncestor("queued-messages-panel");
        expect(
            screen
                .getByTestId("chat-composer")
                .closest('[data-testid="chat-content-column"]'),
        ).toBeNull();
    });

    it("overlays one shared bottom dock above the transcript", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        const dock = screen.getByTestId("chat-bottom-dock");
        expect(dock).toHaveClass(
            "nw-chat-bottom-dock",
            "absolute",
            "bottom-0",
        );
        expect(dock).toContainElement(
            screen.getByTestId("queued-messages-panel"),
        );
        expect(dock).toContainElement(
            screen.getByTestId("edited-files-panel"),
        );
        expect(dock).toContainElement(screen.getByTestId("chat-composer"));
        expect(dock).not.toContainElement(
            screen.getByTestId("chat-message-list"),
        );

        const auxiliaryRegion = screen.getByTestId(
            "chat-bottom-dock-auxiliary-region",
        );
        expect(auxiliaryRegion).toHaveClass(
            "min-h-0",
            "overflow-y-auto",
        );
        expect(auxiliaryRegion).toHaveStyle({ flexShrink: "999" });
        const composerRegion = screen.getByTestId(
            "chat-bottom-dock-composer-region",
        );
        expect(composerRegion).toHaveClass(
            "flex",
            "min-h-16",
            "shrink",
            "flex-col",
        );
        expect(composerRegion).not.toHaveClass("pt-2");
    });

    it("does not reserve an empty context strip above the composer", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        expect(screen.queryByTestId("chat-context-bar")).toBeNull();
    });

    it("renders the context strip when the session has attachments", () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                ...state.sessionsById,
                "session-a": {
                    ...state.sessionsById["session-a"]!,
                    attachments: [
                        {
                            id: "attachment-1",
                            type: "note",
                            noteId: "notes/context.md",
                            label: "Context",
                            path: "/vault/notes/context.md",
                            status: "ready",
                        },
                    ],
                },
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        expect(screen.getByTestId("chat-context-bar")).toBeInTheDocument();
    });

    it("passes the measured bottom dock height to the transcript", async () => {
        const rectSpy = vi
            .spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(function (this: HTMLElement) {
                const height =
                    this.dataset.testid === "chat-bottom-dock"
                        ? 184
                        : 0;
                return {
                    bottom: height,
                    height,
                    left: 0,
                    right: 600,
                    top: 0,
                    width: 600,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                };
            });
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        await waitFor(() => {
            expect(messageListMockState.props.at(-1)?.bottomInset).toBe(184);
        });
        rectSpy.mockRestore();
    });

    it("does not pass a previous session dock measurement into a new chat", async () => {
        let measuredHeight = 180;
        const rectSpy = vi
            .spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(function (this: HTMLElement) {
                const height =
                    this.dataset.testid === "chat-bottom-dock"
                        ? measuredHeight
                        : 0;
                return {
                    bottom: height,
                    height,
                    left: 0,
                    right: 600,
                    top: 0,
                    width: 600,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                };
            });
        setupWorkspaceSession("session-a");

        renderComponent(<AIChatSessionView paneId="primary" />);
        await waitFor(() => {
            expect(messageListMockState.props.at(-1)?.bottomInset).toBe(180);
        });

        act(() => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    "session-b": createSession("session-b", "Second chat"),
                },
            }));
        });
        const propsBeforeSwitch = messageListMockState.props.length;
        measuredHeight = 48;

        act(() => {
            useEditorStore.getState().openChat("session-b", {
                title: "Second chat",
                paneId: "primary",
            });
        });

        await waitFor(() => {
            expect(messageListMockState.props.at(-1)?.sessionId).toBe(
                "session-b",
            );
            expect(messageListMockState.props.at(-1)?.bottomInset).toBe(48);
        });
        const newSessionProps = messageListMockState.props
            .slice(propsBeforeSwitch)
            .filter((props) => props.sessionId === "session-b");
        expect(newSessionProps[0]?.bottomInset).toBe(0);
        rectSpy.mockRestore();
    });

    it("hides the Edited files panel when AI change review is disabled", () => {
        useSettingsStore.getState().setSetting("aiReviewEnabled", false);
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        expect(screen.queryByTestId("edited-files-panel")).toBeNull();
        expect(screen.getByTestId("chat-message-list")).toBeInTheDocument();
        expect(screen.getByTestId("chat-composer")).toBeInTheDocument();
    });

    it("keeps the composer flexible while it is expanded", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.click(screen.getByTestId("chat-composer"));

        expect(screen.getByTestId("chat-composer")).toHaveAttribute(
            "data-expanded",
            "true",
        );
        expect(screen.queryByTestId("chat-bottom-dock")).toBeNull();
        const expandedRegion = screen.getByTestId(
            "chat-expanded-composer-region",
        );
        expect(expandedRegion).toHaveClass(
            "nw-chat-translucent-surface",
            "absolute",
            "inset-0",
        );
        expect(screen.getByTestId("chat-message-list")).toBeInTheDocument();
        expect(screen.getByTestId("chat-transcript-region")).toHaveAttribute(
            "aria-hidden",
            "true",
        );
        expect(screen.getByTestId("chat-transcript-region")).toHaveAttribute(
            "inert",
        );
        expect(
            screen.getByTestId("chat-bottom-dock-composer-region"),
        ).not.toHaveClass("pt-1.5");
    });

    it("closes and disables chat find while the composer is expanded", async () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        const findButton = screen.getByRole("button", {
            name: "Find in chat",
        });
        fireEvent.click(findButton);
        expect(findButton).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(screen.getByTestId("chat-composer"));

        await waitFor(() => {
            expect(findButton).toBeDisabled();
            expect(findButton).toHaveAttribute("aria-pressed", "false");
        });
        expect(screen.getByTestId("chat-message-list")).toBeInTheDocument();
        expect(screen.getByTestId("chat-transcript-region")).toHaveAttribute(
            "inert",
        );

        fireEvent.click(findButton);
        expect(findButton).toHaveAttribute("aria-pressed", "false");
    });

    it("opens a user prompt outline from the local header", () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": {
                    ...state.sessionsById["session-a"]!,
                    messages: [
                        {
                            id: "user-1",
                            role: "user",
                            kind: "text",
                            content: "First prompt",
                            timestamp: 10,
                        },
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Assistant answer",
                            timestamp: 11,
                        },
                        {
                            id: "user-2",
                            role: "user",
                            kind: "text",
                            content: "Second prompt\nwith spacing",
                            timestamp: 12,
                        },
                    ],
                },
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        const outlineButton = screen.getByRole("button", {
            name: "User prompts",
        });
        fireEvent.click(outlineButton);

        expect(outlineButton).toHaveAttribute("aria-pressed", "true");
        expect(
            screen.getByRole("menuitem", { name: "Go to prompt 1" }),
        ).toHaveTextContent("First prompt");
        expect(
            screen.getByRole("menuitem", { name: "Go to prompt 2" }),
        ).toHaveTextContent("Second prompt with spacing");
        expect(screen.queryByText("Assistant answer")).not.toBeInTheDocument();
    });

    it("shows an empty prompt outline state when the session has no user prompts", () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": {
                    ...state.sessionsById["session-a"]!,
                    messages: [
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Assistant answer",
                            timestamp: 11,
                        },
                    ],
                },
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.click(screen.getByRole("button", { name: "User prompts" }));

        expect(screen.getByText("No user prompts")).toBeInTheDocument();
    });

    it("requests message-list navigation when selecting a user prompt", async () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "session-a": {
                    ...state.sessionsById["session-a"]!,
                    messages: [
                        {
                            id: "user-1",
                            role: "user",
                            kind: "text",
                            content: "First prompt",
                            timestamp: 10,
                        },
                        {
                            id: "user-2",
                            role: "user",
                            kind: "text",
                            content: "Second prompt",
                            timestamp: 12,
                        },
                    ],
                },
            },
        }));

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.click(screen.getByRole("button", { name: "User prompts" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Go to prompt 2" }));

        await waitFor(() => {
            expect(screen.getByTestId("chat-message-list")).toHaveAttribute(
                "data-scroll-to-message-id",
                "user-2",
            );
        });
        expect(screen.queryByRole("menu", { name: "User prompts" })).toBeNull();
    });

    it("closes and disables the user prompt outline while the composer is expanded", async () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        const outlineButton = screen.getByRole("button", {
            name: "User prompts",
        });
        fireEvent.click(outlineButton);
        expect(outlineButton).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(screen.getByTestId("chat-composer"));

        await waitFor(() => {
            expect(outlineButton).toBeDisabled();
            expect(outlineButton).toHaveAttribute("aria-pressed", "false");
        });
        expect(screen.queryByRole("menu", { name: "User prompts" })).toBeNull();
    });

    it("closes chat find before Escape can stop the focused agent", async () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        const findButton = screen.getByRole("button", {
            name: "Find in chat",
        });
        fireEvent.click(findButton);
        expect(findButton).toHaveAttribute("aria-pressed", "true");

        const escapeEvent = new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(escapeEvent);

        await waitFor(() => {
            expect(findButton).toHaveAttribute("aria-pressed", "false");
        });
        expect(escapeEvent.defaultPrevented).toBe(true);
    });

    it("shows visible feedback when a pasted image is too large", async () => {
        setupWorkspaceSession();
        renderComponent(<AIChatSessionView paneId="primary" />);
        fireEvent.click(screen.getByTestId("paste-image"));

        const oversizedFile = {
            size: MAX_IMAGE_ATTACHMENT_BYTES + 1,
            type: "image/png",
            arrayBuffer: vi.fn(),
        } as unknown as File;

        await act(async () => {
            await (composerMockState.onPasteImage?.(oversizedFile) as unknown as
                | Promise<void>
                | void);
        });

        expect(screen.getByRole("status")).toHaveTextContent(
            "Codex supports images up to 10 MB",
        );
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_create_draft_attachment",
            expect.anything(),
        );
    });

    it("shows visible feedback for unsupported pasted image types", async () => {
        setupWorkspaceSession();
        renderComponent(<AIChatSessionView paneId="primary" />);
        fireEvent.click(screen.getByTestId("paste-image"));

        const unsupportedFile = {
            size: 128,
            type: "image/tiff",
            arrayBuffer: vi.fn(),
        } as unknown as File;

        await act(async () => {
            await (composerMockState.onPasteImage?.(
                unsupportedFile,
            ) as unknown as Promise<void> | void);
        });

        expect(screen.getByRole("status")).toHaveTextContent(
            "Unsupported image type",
        );
    });

    it("shows visible feedback when the composer already has too many images", async () => {
        setupWorkspaceSession();
        useChatStore.setState((state) => ({
            ...state,
            composerPartsBySessionId: {
                "session-a": Array.from(
                    { length: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE },
                    (_, index) => ({
                        id: `shot-${index}`,
                        type: "screenshot" as const,
                        filePath: `/vault/assets/chat/shot-${index}.png`,
                        mimeType: "image/png",
                        label: `Screenshot ${index}`,
                    }),
                ),
            },
        }));
        renderComponent(<AIChatSessionView paneId="primary" />);
        fireEvent.click(screen.getByTestId("paste-image"));

        const file = {
            size: 128,
            type: "image/png",
            arrayBuffer: vi.fn(),
        } as unknown as File;

        await act(async () => {
            await (composerMockState.onPasteImage?.(file) as unknown as
                | Promise<void>
                | void);
        });

        expect(screen.getByRole("status")).toHaveTextContent(
            "Codex supports up to 12 images per message",
        );
    });

    it("stores pasted images as local drafts without physical paths", async () => {
        setupWorkspaceSession();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_create_draft_attachment") {
                return {
                    draft_attachment_id:
                        "da_0123456789abcdef0123456789abcdef",
                    file_name: "pasted-image.png",
                    mime_type: "image/png",
                };
            }
            return undefined;
        });
        renderComponent(<AIChatSessionView paneId="primary" />);
        fireEvent.click(screen.getByTestId("paste-image"));
        const file = {
            size: 128,
            type: "image/png",
            arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
        } as unknown as File;

        await act(async () => {
            await (composerMockState.onPasteImage?.(file) as unknown as
                | Promise<void>
                | void);
        });

        expect(
            useChatStore.getState().composerPartsBySessionId["session-a"],
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "screenshot",
                    draftAttachmentId:
                        "da_0123456789abcdef0123456789abcdef",
                    fileName: "pasted-image.png",
                    mimeType: "image/png",
                }),
            ]),
        );
        expect(
            useChatStore.getState().composerPartsBySessionId["session-a"],
        ).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ filePath: expect.any(String) }),
            ]),
        );
    });

    it.each(["deleted session", "switched vault"])(
        "releases a pasted draft against its original vault after a %s race",
        async (race) => {
            setupWorkspaceSession();
            let resolveCreate!: (value: {
                draft_attachment_id: string;
                file_name: string;
                mime_type: string;
            }) => void;
            const createResult = new Promise<{
                draft_attachment_id: string;
                file_name: string;
                mime_type: string;
            }>((resolve) => {
                resolveCreate = resolve;
            });
            invokeMock.mockImplementation(async (command) => {
                if (command === "ai_create_draft_attachment") {
                    return createResult;
                }
                return undefined;
            });
            renderComponent(<AIChatSessionView paneId="primary" />);
            fireEvent.click(screen.getByTestId("paste-image"));
            const file = {
                size: 128,
                type: "image/png",
                arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
            } as unknown as File;

            const pasting = composerMockState.onPasteImage?.(file) as unknown as
                | Promise<void>
                | void;
            await waitFor(() => {
                expect(invokeMock).toHaveBeenCalledWith(
                    "ai_create_draft_attachment",
                    expect.objectContaining({ vaultPath: "/vault" }),
                );
            });
            if (race === "deleted session") {
                useChatStore.setState((state) => {
                    const sessionsById = { ...state.sessionsById };
                    delete sessionsById["session-a"];
                    return { sessionsById };
                });
            } else {
                useVaultStore.setState({ vaultPath: "/other-vault" });
            }
            resolveCreate({
                draft_attachment_id:
                    "da_0123456789abcdef0123456789abcdef",
                file_name: "pasted-image.png",
                mime_type: "image/png",
            });
            await act(async () => {
                await pasting;
            });

            expect(invokeMock).toHaveBeenCalledWith(
                "ai_delete_draft_attachment",
                expect.objectContaining({
                    vaultPath: "/vault",
                    draftAttachmentId:
                        "da_0123456789abcdef0123456789abcdef",
                }),
            );
            expect(
                useChatStore.getState().composerPartsBySessionId["session-a"],
            ).not.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        draftAttachmentId:
                            "da_0123456789abcdef0123456789abcdef",
                    }),
                ]),
            );
        },
    );

    it("removes a draft attachment when final validation loses a race", async () => {
        setupWorkspaceSession();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_create_draft_attachment") {
                useChatStore.setState((state) => ({
                    ...state,
                    composerPartsBySessionId: {
                        "session-a": Array.from(
                            { length: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE },
                            (_, index) => ({
                                id: `shot-${index}`,
                                type: "screenshot" as const,
                                filePath: `/vault/assets/chat/shot-${index}.png`,
                                mimeType: "image/png",
                                label: `Screenshot ${index}`,
                            }),
                        ),
                    },
                }));
                return {
                    draft_attachment_id:
                        "da_0123456789abcdef0123456789abcdef",
                    file_name: "pasted-image.png",
                    mime_type: "image/png",
                };
            }
            if (
                command === "ai_delete_draft_attachment"
            ) {
                return undefined;
            }
            if (command === "list_vault_entries") {
                return [];
            }
            return undefined;
        });
        renderComponent(<AIChatSessionView paneId="primary" />);
        fireEvent.click(screen.getByTestId("paste-image"));

        const file = {
            size: 128,
            type: "image/png",
            arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
        } as unknown as File;

        await act(async () => {
            await (composerMockState.onPasteImage?.(file) as unknown as
                | Promise<void>
                | void);
        });

        expect(invokeMock).toHaveBeenCalledWith(
            "ai_delete_draft_attachment",
            expect.objectContaining({
                draftAttachmentId:
                    "da_0123456789abcdef0123456789abcdef",
            }),
        );
        expect(screen.getByRole("status")).toHaveTextContent(
            "Codex supports up to 12 images per message",
        );
        expect(
            useChatStore.getState().composerPartsBySessionId["session-a"],
        ).toHaveLength(MAX_IMAGE_ATTACHMENTS_PER_MESSAGE);
    });
});
