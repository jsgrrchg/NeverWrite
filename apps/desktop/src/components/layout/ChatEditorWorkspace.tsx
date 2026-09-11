import { useRef, type ReactNode } from "react";
import { MIN_CHAT_EDITOR_WIDTH, MIN_CHAT_PANE_WIDTH, selectChatPaneSide, useLayoutStore } from "../../app/store/layoutStore";
import { AIChatPane } from "../../features/ai/components/AIChatPane";
import { useChatTabsStore } from "../../features/ai/store/chatTabsStore";
import { useElementWidth } from "./useElementWidth";

export function getChatEditorWidths(available: number, preferred: number) {
    const narrow = available < MIN_CHAT_PANE_WIDTH + MIN_CHAT_EDITOR_WIDTH + 6;
    return { narrow, chatWidth: narrow ? available : Math.min(preferred, available - MIN_CHAT_EDITOR_WIDTH - 6) };
}

export function ChatEditorWorkspace({ children }: { children: ReactNode }) {
    const { ref, width } = useElementWidth<HTMLDivElement>();
    const visible = useLayoutStore(state => state.chatPaneVisible);
    const preferred = useLayoutStore(state => state.chatPaneWidth);
    const side = useLayoutStore(selectChatPaneSide);
    const focused = useChatTabsStore(state => state.focusedSurface);
    const drag = useRef<{ x: number; width: number } | null>(null);
    const { narrow, chatWidth } = getChatEditorWidths(width ?? 1200, preferred);
    const showChat = visible && (!narrow || focused === "chat");
    const showEditor = !visible || !narrow || focused === "editor";
    return <div ref={ref} className="flex h-full min-h-0 min-w-0 flex-col">
        {(!visible || narrow) && <div className="flex shrink-0 justify-end gap-3 px-3 py-1 text-xs" style={{ background: "var(--bg-secondary)" }}>
            <button type="button" aria-pressed={showEditor} onClick={() => useChatTabsStore.getState().setFocusedSurface("editor")}>Editor</button>
            <button type="button" aria-pressed={showChat} onClick={() => { useLayoutStore.getState().setChatPaneVisible(true); useChatTabsStore.getState().setFocusedSurface("chat"); }}>Chat</button>
        </div>}
        <div className="flex min-h-0 min-w-0 flex-1">
            <div data-testid="dedicated-chat-surface" className="min-h-0 min-w-0 shrink-0" style={{ display: showChat ? undefined : "none", width: narrow ? "100%" : chatWidth, order: side === "left" ? 0 : 2 }}><AIChatPane /></div>
            <div role="separator" aria-label="Resize chat pane" aria-orientation="vertical" aria-valuenow={Math.round(chatWidth)} tabIndex={0} className="shrink-0 cursor-col-resize touch-none" style={{ display: visible && !narrow ? undefined : "none", width: 6, order: 1, background: "var(--border)" }}
                onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const delta = (event.key === "ArrowRight" ? 20 : -20) * (side === "left" ? 1 : -1); useLayoutStore.getState().setChatPaneWidth(chatWidth + delta); }}
                onPointerDown={event => { event.preventDefault(); drag.current = { x: event.clientX, width: chatWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={event => { if (!drag.current) return; const next = drag.current.width + (event.clientX - drag.current.x) * (side === "left" ? 1 : -1); useLayoutStore.getState().setChatPaneWidth(Math.min(next, (width ?? 1200) - MIN_CHAT_EDITOR_WIDTH - 6)); }}
                onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />
            <div className="min-h-0 min-w-0 flex-1" data-testid="document-workspace-surface" style={{ display: showEditor ? undefined : "none", order: side === "left" ? 2 : 0 }} onFocusCapture={() => useChatTabsStore.getState().setFocusedSurface("editor")} onPointerDownCapture={() => useChatTabsStore.getState().setFocusedSurface("editor")}>{children}</div>
        </div>
    </div>;
}
