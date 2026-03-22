import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";

export type ContextMenuEntry =
    | {
          type?: "item";
          label: string;
          action: () => void;
          danger?: boolean;
          disabled?: boolean;
      }
    | {
          type: "separator";
      };

export interface ContextMenuState<T = void> {
    x: number;
    y: number;
    payload: T;
}

export function ContextMenu<T>({
    menu,
    entries,
    onClose,
    minWidth = 180,
    maxHeight,
    zIndex = 10000,
}: {
    menu: ContextMenuState<T>;
    entries: ContextMenuEntry[];
    onClose: () => void;
    minWidth?: number;
    maxHeight?: number;
    zIndex?: number;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [menu.x, menu.y, entries.length]);

    useEffect(() => {
        const handleDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        const handleScroll = (event: Event) => {
            const target = event.target;
            // Always close on document-level scroll
            if (target === document || target === document.documentElement) {
                onClose();
                return;
            }
            // Only close if the scrolling element geometrically contains the
            // menu anchor point — ignore unrelated panels (e.g. AI chat streaming)
            if (target instanceof HTMLElement) {
                const rect = target.getBoundingClientRect();
                if (
                    menu.x >= rect.left &&
                    menu.x <= rect.right &&
                    menu.y >= rect.top &&
                    menu.y <= rect.bottom
                ) {
                    onClose();
                }
            }
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("scroll", handleScroll, true);

        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("scroll", handleScroll, true);
        };
    }, [onClose, menu.x, menu.y]);

    return createPortal(
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex,
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "stretch",
                width: "fit-content",
                minWidth,
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                ...(maxHeight ? { maxHeight, overflowY: "auto" as const } : {}),
            }}
        >
            {entries.map((entry, index) => {
                if (entry.type === "separator") {
                    return (
                        <div
                            key={`separator-${index}`}
                            style={{
                                borderTop: "1px solid var(--border)",
                                margin: "4px 0",
                            }}
                        />
                    );
                }

                return (
                    <button
                        key={`${entry.label}-${index}`}
                        type="button"
                        disabled={entry.disabled}
                        onClick={() => {
                            if (entry.disabled) return;
                            entry.action();
                            onClose();
                        }}
                        className="text-left px-3 py-1.5 text-xs rounded"
                        style={{
                            display: "block",
                            color: entry.danger
                                ? "#ef4444"
                                : "var(--text-primary)",
                            background: "transparent",
                            opacity: entry.disabled ? 0.45 : 1,
                            cursor: entry.disabled ? "default" : "pointer",
                            whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(event) => {
                            if (entry.disabled) return;
                            event.currentTarget.style.backgroundColor =
                                entry.danger
                                    ? "color-mix(in srgb, #ef4444 10%, var(--bg-secondary))"
                                    : "var(--bg-tertiary)";
                        }}
                        onMouseLeave={(event) => {
                            event.currentTarget.style.backgroundColor =
                                "transparent";
                        }}
                    >
                        {entry.label}
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}
