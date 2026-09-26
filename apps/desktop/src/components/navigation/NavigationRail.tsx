import {
    useCallback,
    useState,
    type MouseEvent as ReactMouseEvent,
    type CSSProperties,
    type ReactNode,
} from "react";
import {
    resolveNavigationRailIndexFromPointer,
    resolveNavigationRailTopPercent,
} from "./navigationRail";

function eventTargetsPreview(target: EventTarget) {
    return (
        target instanceof Element &&
        target.closest("[data-navigation-rail-preview]") !== null
    );
}

interface NavigationRailProps<T extends { id: string }> {
    side?: "left" | "right";
    hasPersistentGutter: boolean;
    hitStripWidth: number;
    items: readonly T[];
    stripMap?: Map<string, HTMLSpanElement>;
    onSelect: (item: T) => void;
    getLabel: (item: T | null) => string;
    renderPreview: (item: T) => ReactNode;
    height: CSSProperties["height"];
    previewWidth?: CSSProperties["width"];
    expandedWidth?: CSSProperties["width"];
    getStripWidth?: (item: T) => number;
    isInView?: (item: T) => boolean;
    testId: string;
}

export function NavigationRail<T extends { id: string }>({
    side = "left",
    hasPersistentGutter,
    hitStripWidth,
    items,
    stripMap,
    onSelect,
    getLabel,
    renderPreview,
    height,
    previewWidth = "20rem",
    expandedWidth = "22rem",
    getStripWidth,
    isInView,
    testId,
}: NavigationRailProps<T>) {
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
            : resolveNavigationRailTopPercent(
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
            return resolveNavigationRailIndexFromPointer({
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

    if (items.length < 2) return null;

    return (
        <div
            className="nw-prompt-ring pointer-events-none absolute inset-y-0 z-20 w-[72px]"
            style={{ [side]: 0 }}
            data-side={side}
            data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
            data-testid={testId}
        >
            <button
                type="button"
                aria-label={getLabel(activeItem)}
                tabIndex={hitStripWidth > 0 ? 0 : -1}
                className="absolute top-1/2 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none"
                onBlur={() => setActiveIndex(null)}
                onClick={(event) => {
                    if (eventTargetsPreview(event.target)) return;
                    const index = event.detail === 0
                        ? (resolvedActiveIndex ?? 0)
                        : resolveIndexFromPointer(event);
                    const item = index === null ? null : items[index];
                    if (item) onSelect(item);
                    event.currentTarget.blur();
                }}
                onFocus={() => setActiveIndex((current) => current ?? 0)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.currentTarget.blur();
                        setActiveIndex(null);
                    } else if (event.key === "ArrowDown") {
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
                    [side]: 12,
                    height,
                    pointerEvents: hitStripWidth > 0 ? "auto" : "none",
                    width: activeItem
                        ? expandedWidth
                        : hitStripWidth,
                }}
            >
                <span style={{ [side]: 12 }} className="absolute top-0 h-full w-px bg-[color-mix(in_srgb,var(--border)_35%,transparent)]" />
                {items.map((item, index) => {
                    const distance =
                        resolvedActiveIndex === null
                            ? null
                            : Math.abs(index - resolvedActiveIndex);
                    return (
                        <span
                            aria-hidden="true"
                            className="nw-prompt-ring-strip pointer-events-none absolute h-0.5 -translate-y-1/2 rounded-full"
                            data-active-distance={distance ?? undefined}
                            data-in-view={isInView?.(item) ? "true" : "false"}
                            data-prompt-ring-strip
                            key={item.id}
                            ref={(node) => {
                                if (node) stripMap?.set(item.id, node);
                                else stripMap?.delete(item.id);
                            }}
                            style={{
                                top: `${resolveNavigationRailTopPercent(index, items.length)}%`,
                                [side]: 0,
                                "--navigation-strip-width": getStripWidth?.(item) != null
                                    ? `${getStripWidth(item)}px` : undefined,
                            } as CSSProperties}
                        />
                    );
                })}
                {activeItem ? (
                    <span
                        className="pointer-events-auto absolute cursor-text select-text"
                        data-prompt-ring-preview
                        data-navigation-rail-preview
                        onMouseMove={(event) => event.stopPropagation()}
                        style={{
                            [side]: 32,
                            width: previewWidth,
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
                            {renderPreview(activeItem)}
                        </span>
                    </span>
                ) : null}
            </button>
        </div>
    );
}
