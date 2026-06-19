import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@neverwrite/runtime";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import {
    MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
    MAX_IMAGE_ATTACHMENT_BYTES,
} from "../imageAttachments";
import { AIChatSessionView } from "./AIChatSessionView";
import { AI_CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";

const composerMockState = vi.hoisted(() => ({
    onPasteImage: undefined as ((file: File) => void) | undefined,
}));

const invokeMock = vi.mocked(invoke);

vi.mock("./AIChatMessageList", () => ({
    AIChatMessageList: () => <div data-testid="chat-message-list" />,
}));

vi.mock("./AIChatComposer", () => ({
    AIChatComposer: ({
        disabled,
        expanded,
        footer,
        onToggleExpanded,
        onPasteImage,
        placeholderText,
    }: {
        disabled?: boolean;
        expanded?: boolean;
        footer?: ReactNode;
        onToggleExpanded?: () => void;
        onPasteImage?: (file: File) => void;
        placeholderText?: string;
    }) => (
        <div>
            <button
                type="button"
                data-testid="chat-composer"
                data-disabled={String(Boolean(disabled))}
                data-expanded={String(Boolean(expanded))}
                onClick={onToggleExpanded}
            >
                {placeholderText}
            </button>
            <div data-testid="chat-composer-footer">{footer}</div>
            <button
                type="button"
                data-testid="paste-image"
                onClick={() => {
                    composerMockState.onPasteImage = onPasteImage;
                }}
            />
        </div>
    ),
}));

vi.mock("./AIChatContextBar", () => ({
    AIChatContextBar: () => <div data-testid="chat-context-bar" />,
}));

vi.mock("./AIChatAgentControls", () => ({
    AIChatAgentControls: () => <div data-testid="chat-agent-controls" />,
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
        composerMockState.onPasteImage = undefined;
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
                        filePath: "/vault/assets/chat/old.png",
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

    it("keeps the composer flexible while it is expanded", () => {
        setupWorkspaceSession();

        renderComponent(<AIChatSessionView paneId="primary" />);

        fireEvent.click(screen.getByTestId("chat-composer"));

        expect(screen.getByTestId("chat-composer")).toHaveAttribute(
            "data-expanded",
            "true",
        );
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
        expect(
            screen.queryByTestId("chat-message-list"),
        ).not.toBeInTheDocument();

        fireEvent.click(findButton);
        expect(findButton).toHaveAttribute("aria-pressed", "false");
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
            "save_vault_binary_file",
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

    it("removes a pasted image file when the final attachment validation loses a race", async () => {
        setupWorkspaceSession();
        invokeMock.mockImplementation(async (command) => {
            if (command === "save_vault_binary_file") {
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
                    path: "/vault/assets/chat/pasted-image.png",
                    relative_path: "assets/chat/pasted-image.png",
                    file_name: "pasted-image.png",
                    mime_type: "image/png",
                };
            }
            if (command === "move_vault_entry_to_trash") {
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
            "move_vault_entry_to_trash",
            expect.objectContaining({
                relativePath: "assets/chat/pasted-image.png",
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
