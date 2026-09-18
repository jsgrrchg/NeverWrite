import {
    useCallback,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import {
    CHAT_PROMPT_RING_EXPANDED_WIDTH,
    CHAT_PROMPT_RING_MIN_ITEMS,
    resolveChatPromptRingHeight,
    resolveChatPromptRingIndexFromPointer,
    resolveChatPromptRingTopPercent,
    type ChatPromptRingItem,
} from "./ChatPromptRing.logic";

function eventTargetsPreview(target: EventTarget) {
    return (
        target instanceof Element &&
        target.closest("[data-prompt-ring-preview]") !== null
    );
}

interface ChatPromptRingProps {
    hasPersistentGutter: boolean;
    hitStripWidth: number;
    items: readonly ChatPromptRingItem[];
    stripMap: Map<string, HTMLSpanElement>;
    onSelect: (item: ChatPromptRingItem) => void;
}

export function ChatPromptRing({
    hasPersistentGutter,
    hitStripWidth,
    items,
    stripMap,
    onSelect,
}: ChatPromptRingProps) {
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    const resolvedActiveIndex =
        activeIndex !== null && activeIndex < items.length
            ? activeIndex
            : null;
    const activeItem =
        resolvedActiveIndex === null ? null : items[resolvedActiveIndex] ?? null;
    const activeTopPercent =
        resolvedActiveIndex === null
            ? 0
            : resolveChatPromptRingTopPercent(
                  resolvedActiveIndex,
                  items.length,
              );
    const previewTranslate =
        resolvedActiveIndex === 0
            ? "0%"
            : resolvedActiveIndex === items.length - 1
              ? "-100%"
              : "-50%";

    const resolveIndexFromPointer = useCallback(
        (event: ReactMouseEvent<HTMLElement>) => {
            const rect = event.currentTarget.getBoundingClientRect();
            return resolveChatPromptRingIndexFromPointer({
                itemCount: items.length,
                railTop: rect.top,
                railHeight: rect.height,
                pointerY: event.clientY,
            });
        },
        [items.length],
    );

    const moveActiveIndex = useCallback(
        (delta: number) => {
            setActiveIndex((current) =>
                Math.max(
                    0,
                    Math.min(items.length - 1, (current ?? 0) + delta),
                ),
            );
        },
        [items.length],
    );

    if (items.length < CHAT_PROMPT_RING_MIN_ITEMS) return null;

    return (
        <div
            className="nw-prompt-ring pointer-events-none absolute inset-y-0 left-0 z-20 w-[72px]"
            data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
            data-testid="chat-prompt-ring"
        >
            <button
                type="button"
                aria-label={`Jump to prompt: ${activeItem?.userText ?? "User message"}`}
                className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none"
                onBlur={() => setActiveIndex(null)}
                onClick={(event) => {
                    if (eventTargetsPreview(event.target)) return;
                    const index = resolveIndexFromPointer(event);
                    const item = index === null ? null : items[index];
                    if (item) onSelect(item);
                    event.currentTarget.blur();
                }}
                onFocus={() => setActiveIndex((current) => current ?? 0)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveActiveIndex(1);
                    } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveActiveIndex(-1);
                    } else if (event.key === "Home") {
                        event.preventDefault();
                        setActiveIndex(0);
                    } else if (event.key === "End") {
                        event.preventDefault();
                        setActiveIndex(items.length - 1);
                    } else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (activeItem) onSelect(activeItem);
                    }
                }}
                onMouseLeave={() => setActiveIndex(null)}
                onMouseMove={(event) => {
                    setActiveIndex(resolveIndexFromPointer(event));
                }}
                onMouseDown={(event) => {
                    if (!eventTargetsPreview(event.target)) {
                        event.preventDefault();
                    }
                }}
                style={{
                    height: resolveChatPromptRingHeight(items.length),
                    pointerEvents: hitStripWidth > 0 ? "auto" : "none",
                    width: activeItem
                        ? CHAT_PROMPT_RING_EXPANDED_WIDTH
                        : hitStripWidth,
                }}
            >
                <span className="absolute left-3 top-0 h-full w-px bg-[color-mix(in_srgb,var(--border)_35%,transparent)]" />
                {items.map((item, index) => {
                    const distance =
                        resolvedActiveIndex === null
                            ? null
                            : Math.abs(index - resolvedActiveIndex);
                    return (
                        <span
                            aria-hidden="true"
                            className="nw-prompt-ring-strip pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full"
                            data-active-distance={distance ?? undefined}
                            data-in-view="false"
                            data-prompt-ring-strip
                            key={item.id}
                            ref={(node) => {
                                if (node) stripMap.set(item.id, node);
                                else stripMap.delete(item.id);
                            }}
                            style={{
                                top: `${resolveChatPromptRingTopPercent(index, items.length)}%`,
                            }}
                        />
                    );
                })}
                {activeItem ? (
                    <span
                        className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                        data-prompt-ring-preview
                        onMouseMove={(event) => event.stopPropagation()}
                        style={{
                            top: `${activeTopPercent}%`,
                            transform: `translateY(${previewTranslate})`,
                        }}
                    >
                        <span
                            className="nw-chat-glass-menu block rounded-xl border p-3 text-left shadow-xl"
                            style={{
                                borderColor: "var(--nw-glass-outline)",
                                color: "var(--text-primary)",
                                boxShadow: "0 14px 30px rgba(0,0,0,0.25)",
                            }}
                        >
                            <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                                {activeItem.userText ?? "User message"}
                            </span>
                            {activeItem.assistantText ? (
                                <span
                                    className="mt-1 overflow-hidden text-sm leading-5"
                                    style={{
                                        color: "var(--text-secondary)",
                                        display: "-webkit-box",
                                        WebkitBoxOrient: "vertical",
                                        WebkitLineClamp: 3,
                                    }}
                                >
                                    {activeItem.assistantText}
                                </span>
                            ) : null}
                        </span>
                    </span>
                ) : null}
            </button>
        </div>
    );
}
