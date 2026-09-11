import { isSessionArchived, useArchivedChatsStore } from "./store/archivedChatsStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { getSelectedChatSessionId } from "./chatWorkspaceSelectors";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useVaultStore } from "../../app/store/vaultStore";
import {
    FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
    FILE_TREE_NOTE_DRAG_EVENT,
    emitFileTreeNoteDrag,
    type FileTreeNoteDragDetail,
} from "./dragEvents";
import type { AIChatSession } from "./types";
import {
    ensureWorkspaceChatSession,
    openChatSessionInWorkspace,
} from "./chatPaneMovement";
import { useChatStore } from "./store/chatStore";
import { useAiChatEventBridge } from "./useAiChatEventBridge";
import { createCanonicalAgent } from "./newAgentCreation";

function hasVisibleAiComposerDropZone(targetSessionId?: string) {
    const selector = targetSessionId
        ? `[data-ai-composer-drop-zone="true"][data-ai-composer-session-id="${CSS.escape(targetSessionId)}"]`
        : '[data-ai-composer-drop-zone="true"]';
    return document.querySelector(selector) !== null;
}

function needsLiveSessionResumeContextHydration(session: AIChatSession) {
    if (
        session.runtimeState !== "live" ||
        session.resumeContextPending !== true
    ) {
        return false;
    }

    const persistedCount = session.persistedMessageCount ?? 0;
    return (
        persistedCount > 0 &&
        (session.loadedPersistedMessageStart !== 0 ||
            (session.messages?.length ?? 0) < persistedCount)
    );
}

const attachReplayKeyByDetail = new WeakMap<FileTreeNoteDragDetail, string>();
let nextAttachReplayKey = 1;

function getAttachReplayKey(detail: FileTreeNoteDragDetail) {
    const existingKey = attachReplayKeyByDetail.get(detail);
    if (existingKey) return existingKey;

    const key = `attach-replay-${nextAttachReplayKey}`;
    nextAttachReplayKey += 1;
    attachReplayKeyByDetail.set(detail, key);
    return key;
}

function replayAttachAfterComposerMount(
    detail: FileTreeNoteDragDetail,
    targetSessionId: string,
) {
    const replayKey = getAttachReplayKey(detail);
    // Let the newly selected conversation mount its composer before we replay the
    // attach event into the real in-workspace target.
    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            const replayDetail = { ...detail, targetSessionId };
            attachReplayKeyByDetail.set(replayDetail, replayKey);
            emitFileTreeNoteDrag(replayDetail);
        });
    });
}

function focusComposerAtEnd(sessionId: string) {
    window.requestAnimationFrame(() => {
        window.setTimeout(() => {
            const composer = document.querySelector<HTMLElement>(
                `[data-ai-composer-drop-zone="true"][data-ai-composer-session-id="${CSS.escape(sessionId)}"] [role="textbox"][contenteditable="true"]`,
            );
            if (!composer) return;

            composer.focus();
            const selection = window.getSelection();
            if (!selection) return;

            const range = document.createRange();
            range.selectNodeContents(composer);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }, 0);
    });
}

interface AIChatWorkspaceHostProps {
    startupReady?: boolean;
    initializeWithoutSelection?: boolean;
}

export function AIChatWorkspaceHost({
    startupReady = true,
    initializeWithoutSelection = false,
}: AIChatWorkspaceHostProps) {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const navigation = useChatTabsStore(useShallow(state => ({ view: state.view, focused: state.focusedSurface })));
    const hasSelection = navigation.view.mode === "conversation";
    const activeChatSessionId = navigation.view.mode === "conversation" ? navigation.view.sessionId : null;
    const activeChatSession = useChatStore((state) =>
        activeChatSessionId
            ? (state.sessionsById[activeChatSessionId] ?? null)
            : null,
    );
    const isInitializing = useChatStore((state) => state.isInitializing);
    const chatActions = useRef(useChatStore.getState()).current;
    const initializationPromiseRef = useRef<Promise<unknown> | null>(null);
    const recoveringSessionIdRef = useRef<string | null>(null);
    const attachReplayCountsRef = useRef(new Map<string, number>());

    useAiChatEventBridge(
        Boolean(vaultPath) && startupReady,
    );

    useEffect(() => {
        if (
            !startupReady ||
            !vaultPath ||
            (!hasSelection && !initializeWithoutSelection)
        ) {
            return;
        }

        const initialization = chatActions.initialize({
            createDefaultSession: false,
        });
        initializationPromiseRef.current = initialization;
        void initialization.finally(() => {
            if (initializationPromiseRef.current === initialization) {
                initializationPromiseRef.current = null;
            }
        });
    }, [
        chatActions,
        hasSelection,
        initializeWithoutSelection,
        startupReady,
        vaultPath,
    ]);

    useEffect(() => {
        if (!activeChatSessionId || navigation.focused !== "chat") {
            return;
        }

        chatActions.markSessionFocused(activeChatSessionId);
    }, [activeChatSessionId, chatActions, navigation.focused]);

    useEffect(() => {
        if (
            recoveringSessionIdRef.current &&
            recoveringSessionIdRef.current !== activeChatSessionId
        ) {
            recoveringSessionIdRef.current = null;
        }
    }, [activeChatSessionId]);

    useEffect(() => {
        if (
            !vaultPath ||
            !hasSelection ||
            !startupReady ||
            !activeChatSessionId ||
            isInitializing
        ) {
            return;
        }
        if (activeChatSession?.isResumingSession) {
            return;
        }
        if (activeChatSession?.resumeReconnectFailed) {
            return;
        }
        const shouldHydrateLiveResumeContext = activeChatSession
            ? needsLiveSessionResumeContextHydration(activeChatSession)
            : false;
        if (
            activeChatSession?.runtimeState === "live" &&
            !shouldHydrateLiveResumeContext
        ) {
            return;
        }
        if (recoveringSessionIdRef.current === activeChatSessionId) {
            return;
        }

        recoveringSessionIdRef.current = activeChatSessionId;
        void (async () => {
            await initializationPromiseRef.current?.catch(() => {});
            if (
                recoveringSessionIdRef.current !== activeChatSessionId ||
                getSelectedChatSessionId() !== activeChatSessionId
            ) {
                return;
            }

            const latestSession =
                useChatStore.getState().sessionsById[activeChatSessionId] ??
                null;
            if (latestSession?.isResumingSession) {
                return;
            }
            if (latestSession?.resumeReconnectFailed) {
                return;
            }
            const latestNeedsLiveResumeContextHydration = latestSession
                ? needsLiveSessionResumeContextHydration(latestSession)
                : false;
            if (
                latestSession?.runtimeState === "live" &&
                !latestNeedsLiveResumeContextHydration
            ) {
                return;
            }

            if (latestSession && isSessionArchived(latestSession, useChatStore.getState().sessionsById, useArchivedChatsStore.getState().entries)) {
                await chatActions.ensureSessionTranscriptLoaded(activeChatSessionId, "full");
            } else if (latestNeedsLiveResumeContextHydration) {
                await chatActions.ensureSessionTranscriptLoaded(
                    activeChatSessionId,
                    "full",
                );
            } else {
                await chatActions.loadSession(activeChatSessionId);
            }
        })().finally(() => {
            if (recoveringSessionIdRef.current === activeChatSessionId) {
                recoveringSessionIdRef.current = null;
            }
        });
    }, [
        activeChatSession,
        activeChatSession?.isResumingSession,
        activeChatSession?.loadedPersistedMessageStart,
        activeChatSession?.messages?.length,
        activeChatSession?.persistedMessageCount,
        activeChatSession?.resumeReconnectFailed,
        activeChatSession?.resumeContextPending,
        activeChatSession?.runtimeState,
        activeChatSessionId,
        chatActions,
        hasSelection,
        isInitializing,
        startupReady,
        vaultPath,
    ]);

    useEffect(() => {
        const handleAttachWithoutVisibleComposer = (event: Event) => {
            const detail = (event as CustomEvent<FileTreeNoteDragDetail>)
                .detail;
            const replayKey = getAttachReplayKey(detail);
            if (detail.phase !== "attach") return;
            if (hasVisibleAiComposerDropZone(detail.targetSessionId)) {
                attachReplayCountsRef.current.delete(replayKey);
                return;
            }

            const replayCount =
                attachReplayCountsRef.current.get(replayKey) ?? 0;
            if (replayCount >= 3) {
                attachReplayCountsRef.current.delete(replayKey);
                return;
            }
            attachReplayCountsRef.current.set(replayKey, replayCount + 1);

            const ensureTargetSession = detail.targetSessionId
                ? Promise.resolve(
                      openChatSessionInWorkspace(detail.targetSessionId),
                  )
                : ensureWorkspaceChatSession();

            void ensureTargetSession.then((sessionId) => {
                if (!sessionId) return;
                replayAttachAfterComposerMount(detail, sessionId);
            });
        };

        const handleAttachToNewChat = (event: Event) => {
            const detail = (event as CustomEvent<FileTreeNoteDragDetail>)
                .detail;
            if (detail.phase !== "attach") return;

            void createCanonicalAgent().then((sessionId) => {
                if (!sessionId) return;
                replayAttachAfterComposerMount(detail, sessionId);
                focusComposerAtEnd(sessionId);
            });
        };

        window.addEventListener(
            FILE_TREE_NOTE_DRAG_EVENT,
            handleAttachWithoutVisibleComposer,
        );
        window.addEventListener(
            FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
            handleAttachToNewChat,
        );
        return () => {
            window.removeEventListener(
                FILE_TREE_NOTE_DRAG_EVENT,
                handleAttachWithoutVisibleComposer,
            );
            window.removeEventListener(
                FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
                handleAttachToNewChat,
            );
        };
    }, []);

    return null;
}
