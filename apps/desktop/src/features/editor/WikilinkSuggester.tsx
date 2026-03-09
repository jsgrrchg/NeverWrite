import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import type { WikilinkSuggestionItem } from "./extensions/wikilinkSuggester";

export type WikilinkSuggesterState = {
    x: number;
    y: number;
    query: string;
    selectedIndex: number;
    items: WikilinkSuggestionItem[];
    wholeFrom: number;
    wholeTo: number;
};

export function WikilinkSuggester({
    suggester,
    editorElement,
    onHoverIndex,
    onSelect,
    onClose,
}: {
    suggester: WikilinkSuggesterState;
    editorElement: HTMLElement | null;
    onHoverIndex: (index: number) => void;
    onSelect: (item: WikilinkSuggestionItem) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [position, setPosition] = useState({ x: suggester.x, y: suggester.y });
    const availableAbove = Math.max(180, suggester.y - 18);

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;

        const rect = element.getBoundingClientRect();
        const effectiveHeight = Math.min(rect.height, availableAbove);

        setPosition(
            getViewportSafeMenuPosition(
                suggester.x,
                suggester.y - effectiveHeight - 10,
                rect.width,
                effectiveHeight,
            ),
        );
    }, [availableAbove, suggester.items.length, suggester.x, suggester.y]);

    useEffect(() => {
        itemRefs.current[suggester.selectedIndex]?.scrollIntoView({
            block: "nearest",
        });
    }, [suggester.selectedIndex]);

    useEffect(() => {
        const handleDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (ref.current?.contains(target)) return;
            if (editorElement?.contains(target)) return;
            onClose();
        };

        document.addEventListener("mousedown", handleDown);

        return () => {
            document.removeEventListener("mousedown", handleDown);
        };
    }, [editorElement, onClose]);

    return createPortal(
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10010,
                width: 420,
                maxWidth: "min(420px, calc(100vw - 24px))",
                maxHeight: `${Math.min(availableAbove, 360)}px`,
                overflow: "hidden",
                borderRadius: 14,
                border: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
                background:
                    "color-mix(in srgb, var(--bg-elevated) 96%, transparent)",
                boxShadow: "0 14px 32px rgba(15, 23, 42, 0.14)",
                backdropFilter: "blur(10px)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    maxHeight: "inherit",
                }}
            >
                <div
                    style={{
                        padding: "10px 12px 8px",
                        borderBottom:
                            "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        color: "var(--text-secondary)",
                    }}
                >
                    {suggester.query.trim()
                        ? `Linking "${suggester.query.trim()}"`
                        : "Link note"}
                </div>
                <div
                    style={{
                        overflowY: "auto",
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                    }}
                >
                    {suggester.items.length ? (
                        suggester.items.map((item, index) => {
                            const isActive = index === suggester.selectedIndex;
                            return (
                                <button
                                    key={item.id}
                                    ref={(element) => {
                                        itemRefs.current[index] = element;
                                    }}
                                    type="button"
                                    onMouseEnter={() => onHoverIndex(index)}
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        onSelect(item);
                                    }}
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "stretch",
                                        border: "none",
                                        borderRadius: 10,
                                        background: isActive
                                            ? "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))"
                                            : "transparent",
                                        padding: "10px 12px",
                                        textAlign: "left",
                                        cursor: "pointer",
                                    }}
                                    >
                                        <div
                                            style={{
                                                color: "var(--text-primary)",
                                                fontSize: 15,
                                                fontWeight: 600,
                                                lineHeight: 1.3,
                                            }}
                                        >
                                            {item.title}
                                        </div>
                                </button>
                            );
                        })
                    ) : (
                        <div
                            style={{
                                padding: "16px 12px",
                                color: "var(--text-secondary)",
                                fontSize: 13,
                                textAlign: "center",
                            }}
                        >
                            No notes found
                        </div>
                    )}
                </div>
                <div
                    style={{
                        padding: "8px 12px 10px",
                        borderTop:
                            "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                        color: "var(--text-secondary)",
                        fontSize: 11,
                        textAlign: "center",
                    }}
                >
                    Use Arrow keys to navigate and Enter to confirm
                </div>
            </div>
        </div>,
        document.body,
    );
}
