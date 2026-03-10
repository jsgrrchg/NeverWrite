import { useCallback, useEffect, useRef, useState } from "react";
import { AIChatMessageItem } from "./AIChatMessageItem";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import type { AIChatMessage } from "../types";

interface AIChatMessageListProps {
    messages: AIChatMessage[];
    chatFontSize?: number;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}

const NEAR_BOTTOM_THRESHOLD = 80;

function isNearBottom(el: HTMLElement) {
    return (
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
    );
}

export function AIChatMessageList({
    messages,
    chatFontSize = 14,
    onPermissionResponse,
}: AIChatMessageListProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const wasNearBottomRef = useRef(true);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        hasSelection: boolean;
    }> | null>(null);

    const scrollToBottom = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        setShowScrollButton(false);
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        if (wasNearBottomRef.current) {
            container.scrollTop = container.scrollHeight;
        } else {
            setShowScrollButton(true);
        }
    }, [messages]);

    const handleScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const nearBottom = isNearBottom(container);
        wasNearBottomRef.current = nearBottom;
        if (nearBottom) setShowScrollButton(false);
    }, []);

    const handleContextMenu = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        const selection = window.getSelection();
        const hasSelection = !!selection && !selection.isCollapsed;
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { hasSelection },
        });
    }, []);

    return (
        <div className="relative min-h-0 min-w-0 flex-1">
            <div
                ref={containerRef}
                onScroll={handleScroll}
                onContextMenu={handleContextMenu}
                className="h-full min-w-0 overflow-y-auto px-3 py-3"
                data-scrollbar-active="true"
            >
                <div
                    className="flex min-w-0 flex-col gap-2"
                    data-selectable="true"
                    style={{ fontSize: chatFontSize }}
                >
                    {messages.map((message, index) => (
                        <AIChatMessageItem
                            key={message.id}
                            message={message}
                            isLast={index === messages.length - 1}
                            onPermissionResponse={onPermissionResponse}
                        />
                    ))}
                </div>
            </div>
            {showScrollButton && (
                <button
                    type="button"
                    onClick={scrollToBottom}
                    className="absolute bottom-3 left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full"
                    style={{
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                        color: "var(--text-secondary)",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                    }}
                    aria-label="Scroll to bottom"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M7 3v8M3.5 7.5L7 11l3.5-3.5" />
                    </svg>
                </button>
            )}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Copy",
                            disabled: !contextMenu.payload.hasSelection,
                            action: () => {
                                const selection = window.getSelection();
                                if (selection && !selection.isCollapsed) {
                                    navigator.clipboard.writeText(
                                        selection.toString(),
                                    );
                                }
                            },
                        },
                    ]}
                />
            )}
        </div>
    );
}
