import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./chat.css";
import { AIChatMessageList } from "../../src/features/ai/components/AIChatMessageList";
import { announceChatSubmission } from "../../src/features/ai/store/chatSubmissionStore";
import type { AIChatMessage, AIChatSessionStatus } from "../../src/features/ai/types";

function message(id: string, role: "user" | "assistant", content: string): AIChatMessage {
    return { id, role, content, kind: "text", timestamp: Date.now() };
}

const history = Array.from({ length: 30 }, (_, i) => message(
    `history-${i}`, i % 2 ? "assistant" : "user",
    `Earlier message ${i}. This is a conversation that already fills the viewport.`,
));

export interface TranscriptFixture {
    send: (id: string) => void;
    reply: (paragraphs: number) => void;
    finish: () => void;
    switchSession: (id: string) => void;
    dock: (height: number) => void;
    remove: (id: string) => void;
    prepend: () => void;
    replay: (id: string) => void;
    navigate: (id: string) => void;
    enableHistory: () => void;
    find: () => void;
}

declare global {
    interface Window { transcriptFixture: TranscriptFixture }
}

const EMPTY_MESSAGES: AIChatMessage[] = [];

export function Fixture() {
    const [sessionId, setSessionId] = useState("main");
    const [sessions, setSessions] = useState<Record<string, AIChatMessage[]>>({ main: history });
    const [status, setStatus] = useState<AIChatSessionStatus>("idle");
    const [bottomInset, setBottomInset] = useState(120);
    const [navigation, setNavigation] = useState<string | null>(null);
    const [hasOlder, setHasOlder] = useState(false);
    const [findOpen, setFindOpen] = useState(false);
    const messages = sessions[sessionId] ?? EMPTY_MESSAGES;
    useLayoutEffect(() => {
        const append = (next: AIChatMessage) => setSessions((all) => ({
            ...all, [sessionId]: [...(all[sessionId] ?? []), next],
        }));
        window.transcriptFixture = {
            send: (id) => {
                append(message(id, "user", `New prompt ${id}`));
                setStatus("streaming");
                announceChatSubmission(sessionId, id);
            },
            reply: (paragraphs) => {
                const prompt = messages.findLast((row) => row.role === "user")!;
                const id = `reply-${prompt.id}`;
                const content = Array.from({ length: paragraphs }, (_, i) =>
                    `Paragraph ${i}. The answer gradually takes up the space reserved below the new prompt.`).join("\n\n");
                setSessions((all) => ({
                    ...all,
                    [sessionId]: [...all[sessionId].filter((row) => row.id !== id), message(id, "assistant", content)],
                }));
            },
            finish: () => setStatus("idle"),
            switchSession: setSessionId,
            dock: setBottomInset,
            navigate: setNavigation,
            enableHistory: () => setHasOlder(true),
            find: () => setFindOpen(true),
            remove: (id) => setSessions((all) => ({
                ...all, [sessionId]: all[sessionId].filter((row) => row.id !== id),
            })),
            prepend: () => setSessions((all) => ({
                ...all, [sessionId]: [message("older", "assistant", "Older history.\n\n".repeat(10)), ...all[sessionId]],
            })),
            replay: (id) => append(message(id, "user", "A user message loaded from history.")),
        };
    }, [messages, sessionId]);
    return (
        <div style={{ height: "100vh", width: "100%", display: "flex", flexDirection: "column" }}>
            <AIChatMessageList
                sessionId={sessionId} messages={messages} status={status} bottomInset={bottomInset}
                scrollToMessageId={navigation} onScrollToMessageComplete={() => setNavigation(null)}
                hasOlderMessages={hasOlder}
                findOpen={findOpen} onCloseFind={() => setFindOpen(false)}
                onLoadOlderMessages={() => {
                    window.transcriptFixture.prepend();
                    setHasOlder(false);
                }}
            />
            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: bottomInset, pointerEvents: "none" }}>
                Composer
            </div>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
