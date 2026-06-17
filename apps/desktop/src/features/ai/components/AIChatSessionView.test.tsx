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
        expanded,
        footer,
        onToggleExpanded,
        onPasteImage,
    }: {
        expanded?: boolean;
        footer?: ReactNode;
        onToggleExpanded?: () => void;
        onPasteImage?: (file: File) => void;
    }) => (
        <div>
            <button
                type="button"
                data-testid="chat-composer"
                data-expanded={String(Boolean(expanded))}
                onClick={onToggleExpanded}
            />
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
            "Image is too large",
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
            "Too many images attached",
        );
    });
});
