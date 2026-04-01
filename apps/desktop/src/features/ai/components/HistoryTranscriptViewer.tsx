import { useEffect, useMemo } from "react";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useChatStore } from "../store/chatStore";
import {
    formatSessionTime,
    getRuntimeName,
    getSessionTitle,
} from "../sessionPresentation";
import type { AIChatSession } from "../types";
import { AIChatMessageList } from "./AIChatMessageList";

interface HistoryTranscriptViewerProps {
    sessionId: string;
    chatFontSize?: number;
    chatFontFamily?: EditorFontFamily;
}

function TranscriptHeader({ session }: { session: AIChatSession }) {
    const runtimes = useChatStore((s) => s.runtimes);
    const runtimeOptions = useMemo(
        () => runtimes.map((d) => d.runtime),
        [runtimes],
    );
    const title = getSessionTitle(session);
    const runtimeLabel = getRuntimeName(session.runtimeId, runtimeOptions);
    const modelLabel = session.modelId;
    const updatedAt = session.persistedUpdatedAt ?? 0;

    return (
        <div
            className="flex shrink-0 items-center gap-2 px-3 py-2"
            style={{
                borderBottom: "1px solid var(--border)",
                color: "var(--text-primary)",
            }}
        >
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {title}
            </span>
            <span
                className="shrink-0 text-[10px]"
                style={{ color: "var(--text-secondary)", opacity: 0.7 }}
            >
                {runtimeLabel}
                {modelLabel ? ` · ${modelLabel}` : ""}
            </span>
            {updatedAt > 0 && (
                <span
                    className="shrink-0 text-[10px]"
                    style={{ color: "var(--text-secondary)", opacity: 0.7 }}
                >
                    {formatSessionTime(updatedAt)}
                </span>
            )}
        </div>
    );
}

export function HistoryTranscriptViewer({
    sessionId,
    chatFontSize,
    chatFontFamily,
}: HistoryTranscriptViewerProps) {
    const session = useChatStore((s) => s.sessionsById[sessionId]);
    const ensureTranscriptLoaded = useChatStore(
        (s) => s.ensureSessionTranscriptLoaded,
    );
    const loadSession = useChatStore((s) => s.loadSession);
    const vaultPath = useVaultStore((s) => s.vaultPath);

    const storeFontSize = useChatStore((s) => s.chatFontSize);
    const storeFontFamily = useChatStore((s) => s.chatFontFamily);
    const effectiveFontSize = chatFontSize ?? storeFontSize;
    const effectiveFontFamily = chatFontFamily ?? storeFontFamily;

    useEffect(() => {
        if (!session) return;
        void ensureTranscriptLoaded(sessionId, "full");
    }, [sessionId, session, ensureTranscriptLoaded]);

    if (!session) {
        return (
            <div
                className="flex h-full items-center justify-center text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                Session not found.
            </div>
        );
    }

    const hasOlderMessages = (session.loadedPersistedMessageStart ?? 0) > 0;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <TranscriptHeader session={session} />
            <AIChatMessageList
                sessionId={sessionId}
                messages={session.messages}
                status="idle"
                readOnly
                hasOlderMessages={hasOlderMessages}
                isLoadingOlderMessages={
                    session.isLoadingPersistedMessages ?? false
                }
                chatFontSize={effectiveFontSize}
                chatFontFamily={effectiveFontFamily}
                onLoadOlderMessages={() => {
                    void ensureTranscriptLoaded(sessionId, "full");
                }}
            />
        </div>
    );
}
