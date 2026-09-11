import { useRef, useState, type ReactNode } from "react";
import {
    getChatEditorWidths,
    MIN_CHAT_EDITOR_WIDTH,
    selectChatPaneSide,
    useLayoutStore,
} from "../../app/store/layoutStore";
import { useEditorStore } from "../../app/store/editorStore";
import { AIChatPane } from "../../features/ai/components/AIChatPane";
import { useChatTabsStore } from "../../features/ai/store/chatTabsStore";
import { useElementWidth } from "./useElementWidth";

export function ChatEditorWorkspace({ children }: { children: ReactNode }) {
    const { ref, width } = useElementWidth<HTMLDivElement>();
    const visible = useLayoutStore((state) => state.chatPaneVisible);
    const preferred = useLayoutStore((state) => state.chatPaneWidth);
    const side = useLayoutStore(selectChatPaneSide);
    const hasEditorTabs = useEditorStore((state) =>
        state.panes.some((pane) => pane.tabs.length > 0),
    );
    const [resizing, setResizing] = useState(false);
    const drag = useRef<{ x: number; width: number } | null>(null);
    const { chatWidth } = getChatEditorWidths(width ?? 1200, preferred);
    const showChat =
        !hasEditorTabs || visible;
    const showEditor =
        hasEditorTabs;
    return (
        <div ref={ref} className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="flex min-h-0 min-w-0 flex-1">
                <div
                    data-testid="dedicated-chat-surface"
                    className="min-h-0 min-w-0 shrink-0"
                    style={{
                        display: showChat ? undefined : "none",
                        width: !hasEditorTabs ? "100%" : chatWidth,
                        order: side === "left" ? 0 : 2,
                    }}
                >
                    <AIChatPane />
                </div>
                <div
                    className="relative shrink-0"
                    style={{
                        display: hasEditorTabs && visible ? undefined : "none",
                        width: 1,
                        order: 1,
                        zIndex: 10,
                        background: "color-mix(in srgb, var(--border) 40%, transparent)",
                    }}
                >
                    <div
                        role="separator"
                        aria-label="Resize chat pane"
                        aria-orientation="vertical"
                        aria-valuenow={Math.round(chatWidth)}
                        tabIndex={0}
                        className="group/resizer absolute h-full cursor-col-resize touch-none outline-none"
                        style={{ left: -4.5, width: 10 }}
                        onKeyDown={(event) => {
                            if (
                                event.key !== "ArrowLeft" &&
                                event.key !== "ArrowRight"
                            )
                                return;
                            event.preventDefault();
                            const delta =
                                (event.key === "ArrowRight" ? 20 : -20) *
                                (side === "left" ? 1 : -1);
                            useLayoutStore
                                .getState()
                                .setChatPaneWidth(chatWidth + delta);
                        }}
                        onPointerDown={(event) => {
                            event.preventDefault();
                            setResizing(true);
                            drag.current = { x: event.clientX, width: chatWidth };
                            event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                            if (!drag.current) return;
                            const next =
                                drag.current.width +
                                (event.clientX - drag.current.x) *
                                    (side === "left" ? 1 : -1);
                            useLayoutStore
                                .getState()
                                .setChatPaneWidth(
                                    Math.min(
                                        next,
                                        (width ?? 1200) - MIN_CHAT_EDITOR_WIDTH - 1,
                                    ),
                                );
                        }}
                        onPointerUp={() => {
                            drag.current = null;
                            setResizing(false);
                        }}
                        onPointerCancel={() => {
                            drag.current = null;
                            setResizing(false);
                        }}
                        onLostPointerCapture={() => {
                            drag.current = null;
                            setResizing(false);
                        }}
                    >
                        <div
                            aria-hidden="true"
                            className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full opacity-0 transition-opacity duration-150 group-hover/resizer:opacity-100 group-focus-visible/resizer:opacity-100"
                            style={{
                                background: "color-mix(in srgb, var(--accent) 40%, var(--border))",
                                opacity: resizing ? 1 : undefined,
                            }}
                        />
                    </div>
                </div>
                <div
                    className="min-h-0 min-w-0 flex-1 overflow-hidden"
                    data-testid="document-workspace-surface"
                    style={{
                        display: showEditor ? undefined : "none",
                        order: side === "left" ? 2 : 0,
                    }}
                    onFocusCapture={() =>
                        useChatTabsStore.getState().setFocusedSurface("editor")
                    }
                    onPointerDownCapture={() =>
                        useChatTabsStore.getState().setFocusedSurface("editor")
                    }
                >
                    {children}
                </div>
            </div>
        </div>
    );
}
