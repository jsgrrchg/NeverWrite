import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AIChatMessage, AIChatSessionStatus } from "../types";
import { useChatSubmissionStore } from "../store/chatSubmissionStore";
import {
    captureVisibleChatAnchor, findChatRowByKey, persistChatMessageListViewState,
    readPersistedChatMessageListViewState, resolveChatMessageListViewStateScope,
    restoreChatMessageListViewState, type VisibleChatAnchorSnapshot,
} from "./chatMessageListViewState";

const NEAR_BOTTOM_PX = 80;
const PROMPT_TOP_PX = 24;
const GLIDE_MS = 220;

interface Options {
    sessionId: string | null;
    messages: AIChatMessage[];
    status: AIChatSessionStatus;
    bottomInset: number;
    readOnly: boolean;
    hasOlderMessages: boolean;
    isLoadingOlderMessages: boolean;
    onLoadOlderMessages?: () => void;
}

type ScrollMode = "prompt" | "following" | "reading";

function nearBottom(container: HTMLElement) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
}

function findPrompt(container: HTMLElement, id: string) {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-chat-message-id]"))
        .find((row) => row.dataset.chatMessageId === id);
}

/** One owner for send anchoring, tail following, reading and history restoration. */
export function useChatTranscriptScroll(options: Options) {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const rowsRef = useRef<HTMLDivElement>(null);
    const runwayRef = useRef<HTMLDivElement>(null);
    const latest = useRef(options);
    latest.current = options;
    const submissions = useChatSubmissionStore();
    const submission = options.sessionId
        ? submissions.submissionsBySessionId[options.sessionId] : undefined;
    // Mounting/revisiting a transcript is not a new send.
    const seenRevision = useRef(submissions.revision);
    const scope = resolveChatMessageListViewStateScope(options.sessionId);
    const [reservedBottomInset, setReservedBottomInset] = useState(options.bottomInset);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const state = useRef({
        scope: "", mode: "following" as ScrollMode,
        runwayId: null as string | null, seenPrompt: false,
        inset: options.bottomInset,
        anchor: null as VisibleChatAnchorSnapshot | null,
        messages: options.messages,
        loadingOlder: options.isLoadingOlderMessages,
        restore: null as ReturnType<typeof readPersistedChatMessageListViewState>,
        prepend: null as {
            height: number; top: number; firstId?: string;
            anchor: VisibleChatAnchorSnapshot;
        } | null,
        glide: null as { start: number; from: number } | null,
        frame: 0,
        writtenTop: null as number | null,
    });

    const cancelGlide = useCallback(() => {
        const current = state.current;
        if (current.frame) cancelAnimationFrame(current.frame);
        current.frame = 0;
        current.glide = null;
    }, []);

    const syncScrollButton = useCallback(() => {
        const container = containerRef.current;
        setShowScrollButton(Boolean(container && state.current.mode !== "prompt"
            && container.scrollHeight > container.clientHeight && !nearBottom(container)));
    }, []);

    const remember = useCallback(() => {
        const container = containerRef.current;
        const current = state.current;
        if (!container || current.restore) return;
        // Held prompts restore as reader-owned anchors, even at the geometric end.
        const follows = () => current.mode === "following";
        current.anchor = captureVisibleChatAnchor(container, follows);
        persistChatMessageListViewState(current.scope, container, follows, current.runwayId);
    }, []);

    const releaseForNavigation = useCallback(() => {
        cancelGlide();
        state.current.mode = "reading";
        state.current.writtenTop = null;
        state.current.restore = null;
        remember();
        syncScrollButton();
    }, [cancelGlide, remember, syncScrollButton]);

    const restoreAnchor = useCallback((anchor: VisibleChatAnchorSnapshot | null) => {
        const container = containerRef.current;
        if (!container || !anchor?.rowKey) return false;
        const row = findChatRowByKey(container, anchor.rowKey);
        if (!row) return false;
        const delta = row.getBoundingClientRect().top
            - container.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > 0.5) container.scrollTop += delta;
        return true;
    }, []);

    const reconcile = useCallback(() => {
        const container = containerRef.current;
        const rows = rowsRef.current;
        const runway = runwayRef.current;
        const current = state.current;
        if (!container || !rows || !runway || !container.clientHeight) return;
        const args = latest.current;
        if (current.scope !== resolveChatMessageListViewStateScope(args.sessionId)) return;

        // Keep a shrinking dock's old reservation while reading to avoid clamping.
        if (args.bottomInset > current.inset || current.mode !== "reading") {
            current.inset = args.bottomInset;
            setReservedBottomInset(current.inset);
        }
        const bottomPadding = Math.max(0, current.inset) + 12;
        // Update both reservations before paint, also inside ResizeObserver.
        container.style.paddingBottom = `${bottomPadding}px`;
        container.style.scrollPaddingBottom = `${bottomPadding}px`;

        let target: number | null = null;
        let space = 0;
        if (current.runwayId) {
            const prompt = findPrompt(container, current.runwayId);
            if (prompt) {
                current.seenPrompt = true;
                const promptTop = prompt.getBoundingClientRect().top;
                const naturalTop = container.scrollTop + promptTop - container.getBoundingClientRect().top;
                const inset = Math.min(PROMPT_TOP_PX, naturalTop);
                const turnHeight = rows.getBoundingClientRect().bottom - promptTop;
                space = Math.max(0, container.clientHeight - bottomPadding - inset - turnHeight);
                target = Math.max(0, naturalTop - inset);
                if (space <= 0.5) {
                    current.runwayId = null;
                    if (current.mode === "prompt") current.mode = "following";
                    cancelGlide();
                }
            } else if (current.seenPrompt) {
                // Failed/removed optimistic echo: retire its reservation.
                current.runwayId = null;
                if (current.mode === "prompt") current.mode = "reading";
                cancelGlide();
            }
        }
        const height = `${space}px`;
        if (runway.style.height !== height) runway.style.height = height;

        if (current.restore) {
            if (args.messages.length === 0 && !current.restore.nearBottom) return;
            restoreChatMessageListViewState(container, current.restore);
            current.restore = null;
        } else if (current.mode === "prompt" && target !== null) {
            const glide = current.glide;
            if (glide) {
                const progress = Math.min(1, (performance.now() - glide.start) / GLIDE_MS);
                container.scrollTop = glide.from + (target - glide.from) * (1 - (1 - progress) ** 3);
                if (progress === 1) current.glide = null;
            } else {
                container.scrollTop = target;
            }
        } else if (current.prepend && args.messages[0]?.id !== current.prepend.firstId) {
            const prepend = current.prepend;
            current.prepend = null;
            if (!restoreAnchor(prepend.anchor)) {
                container.scrollTop = container.scrollHeight - prepend.height + prepend.top;
            }
        } else if (current.mode === "following") {
            container.scrollTop = container.scrollHeight;
        } else {
            restoreAnchor(current.anchor);
        }
        current.writtenTop = container.scrollTop;
        remember();
        syncScrollButton();
    }, [cancelGlide, remember, restoreAnchor, syncScrollButton]);

    const startGlide = useCallback(() => {
        const tick = () => {
            const current = state.current;
            current.frame = 0;
            // A send can fail and remove its echo before React paints it.
            // Never keep an animation alive waiting for a row that was rolled back.
            if (current.mode === "prompt" && current.runwayId && containerRef.current
                && !findPrompt(containerRef.current, current.runwayId)) {
                current.runwayId = null;
                current.mode = "reading";
                cancelGlide();
            }
            reconcile();
            if (state.current.glide) state.current.frame = requestAnimationFrame(tick);
        };
        state.current.frame = requestAnimationFrame(tick);
    }, [cancelGlide, reconcile]);

    useLayoutEffect(() => {
        const current = state.current;
        const freshSend = submission && submission.revision > seenRevision.current;
        seenRevision.current = submissions.revision;
        if (current.scope !== scope) {
            cancelGlide();
            const saved = readPersistedChatMessageListViewState(scope);
            current.scope = scope;
            current.mode = saved?.nearBottom === false ? "reading" : "following";
            current.runwayId = options.readOnly ? null : saved?.runwayMessageId ?? null;
            current.seenPrompt = false;
            current.restore = saved;
            current.prepend = null;
            current.anchor = null;
            current.inset = options.bottomInset;
            setReservedBottomInset(options.bottomInset);
        }
        if (freshSend && submission?.sessionId === options.sessionId && !options.readOnly) {
            cancelGlide();
            current.mode = "prompt";
            current.runwayId = submission.messageId;
            current.seenPrompt = false;
            current.restore = null;
            current.prepend = null;
            const container = containerRef.current;
            if (container && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
                current.glide = { start: performance.now(), from: container.scrollTop };
            }
            startGlide();
        }
        reconcile();
        if (!options.isLoadingOlderMessages && current.prepend
            && (current.loadingOlder || current.messages !== options.messages)) {
            current.prepend = null;
        }
        current.messages = options.messages;
        current.loadingOlder = options.isLoadingOlderMessages;
    }, [submission, submissions.revision, scope, options.sessionId, options.readOnly,
        options.hasOlderMessages, options.isLoadingOlderMessages, options.messages, options.status,
        options.bottomInset, reconcile, cancelGlide, startGlide]);

    const handleScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        const current = state.current;
        const programmatic = current.writtenTop !== null
            && Math.abs(container.scrollTop - current.writtenTop) < 1;
        // Restoration, layout corrections and animation are not user intent.
        if (!programmatic && current.mode !== "prompt") {
            current.mode = nearBottom(container) ? "following" : "reading";
            if (current.mode === "following" && current.inset !== latest.current.bottomInset) reconcile();
        }
        remember();
        syncScrollButton();
        const args = latest.current;
        if (!programmatic && current.mode !== "prompt" && container.scrollTop <= 120
            && args.hasOlderMessages && !args.isLoadingOlderMessages
            && args.onLoadOlderMessages && !current.prepend) {
            current.prepend = {
                height: container.scrollHeight, top: container.scrollTop,
                firstId: args.messages[0]?.id,
                anchor: captureVisibleChatAnchor(container, () => false),
            };
            args.onLoadOlderMessages();
        }
    }, [reconcile, remember, syncScrollButton]);

    const scrollToBottom = useCallback(() => {
        cancelGlide();
        state.current.mode = "following";
        state.current.restore = null;
        reconcile();
    }, [cancelGlide, reconcile]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const rows = rowsRef.current;
        if (!container || !rows) return;
        const onWheel = (event: WheelEvent) => {
            releaseForNavigation();
            // Downward input at the end retains follow intent without a scroll event.
            if (event.deltaY > 0 && nearBottom(container)) state.current.mode = "following";
        };
        const onPointer = (event: PointerEvent) => {
            if (event.button === 0) releaseForNavigation();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
            if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) releaseForNavigation();
        };
        container.addEventListener("wheel", onWheel, { passive: true });
        container.addEventListener("touchstart", releaseForNavigation, { passive: true });
        container.addEventListener("pointerdown", onPointer);
        container.addEventListener("keydown", onKey);
        const observer = new ResizeObserver(reconcile);
        observer.observe(container);
        // Exclude the runway to avoid a resize feedback loop.
        observer.observe(rows);
        return () => {
            cancelGlide();
            observer.disconnect();
            container.removeEventListener("wheel", onWheel);
            container.removeEventListener("touchstart", releaseForNavigation);
            container.removeEventListener("pointerdown", onPointer);
            container.removeEventListener("keydown", onKey);
        };
    }, [cancelGlide, reconcile, releaseForNavigation]);

    return {
        containerRef, contentRef, rowsRef, runwayRef,
        reservedBottomInset, showScrollButton, handleScroll, scrollToBottom,
        releaseForNavigation, syncScrollButton,
    };
}
