import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../../app/utils/menuPosition";

export interface AIChatSlashCommand {
    id: string;
    label: string;
    description: string;
    insertText: string;
}

function CommandIcon() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            style={{ color: "var(--accent)" }}
        >
            <path d="M4.5 2L9.5 7L4.5 12" />
        </svg>
    );
}

interface AIChatCommandPickerProps {
    open: boolean;
    x: number;
    y: number;
    query: string;
    selectedIndex: number;
    items: AIChatSlashCommand[];
    anchorElement: HTMLElement | null;
    onHoverIndex: (index: number) => void;
    onSelect: (item: AIChatSlashCommand) => void;
    onClose: () => void;
}

export function AIChatCommandPicker({
    open,
    x,
    y,
    selectedIndex,
    items,
    anchorElement,
    onHoverIndex,
    onSelect,
    onClose,
}: AIChatCommandPickerProps) {
    const ref = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [position, setPosition] = useState({ x, y });

    useLayoutEffect(() => {
        if (!open) return;
        const element = ref.current;
        if (!element) return;

        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                x,
                y - rect.height - 8,
                rect.width,
                rect.height,
            ),
        );
    }, [open, x, y, items.length]);

    useEffect(() => {
        if (!open) return;
        itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }, [open, selectedIndex]);

    useEffect(() => {
        if (!open) return;

        const handleDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (ref.current?.contains(target)) return;
            if (anchorElement?.contains(target)) return;
            onClose();
        };

        document.addEventListener("mousedown", handleDown);
        return () => document.removeEventListener("mousedown", handleDown);
    }, [anchorElement, onClose, open]);

    if (!open) return null;

    return createPortal(
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10010,
                width: 340,
                maxWidth: "min(340px, calc(100vw - 24px))",
                maxHeight: 280,
                overflow: "hidden",
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
                background:
                    "color-mix(in srgb, var(--bg-elevated) 97%, transparent)",
                boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12)",
                backdropFilter: "blur(10px)",
            }}
        >
            <div
                style={{
                    overflowY: "auto",
                    padding: 4,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    maxHeight: 280,
                }}
            >
                {items.length ? (
                    items.map((item, index) => {
                        const isActive = index === selectedIndex;
                        return (
                            <button
                                key={item.id}
                                ref={(element) => {
                                    itemRefs.current[index] = element;
                                }}
                                type="button"
                                data-ai-command-picker="true"
                                onMouseEnter={() => onHoverIndex(index)}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    onSelect(item);
                                }}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    border: "none",
                                    borderRadius: 7,
                                    background: isActive
                                        ? "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))"
                                        : "transparent",
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    cursor: "pointer",
                                    minWidth: 0,
                                    transition: "background-color 80ms ease",
                                }}
                            >
                                <CommandIcon />
                                <span
                                    style={{
                                        color: "var(--accent)",
                                        fontSize: 13,
                                        fontWeight: 600,
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        flex: 1,
                                        minWidth: 0,
                                    }}
                                >
                                    {item.label}
                                </span>
                                <span
                                    style={{
                                        fontSize: 11,
                                        color: "var(--text-secondary)",
                                        opacity: 0.6,
                                        flexShrink: 0,
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {item.description}
                                </span>
                            </button>
                        );
                    })
                ) : (
                    <div
                        style={{
                            padding: "12px 10px",
                            color: "var(--text-secondary)",
                            fontSize: 12,
                            textAlign: "center",
                        }}
                    >
                        No commands found
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}
