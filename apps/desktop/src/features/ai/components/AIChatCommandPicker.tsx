import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useComposerPickerPosition } from "./useComposerPickerPosition";

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
    selectedIndex: number;
    items: AIChatSlashCommand[];
    anchorElement: HTMLElement | null;
    onHoverIndex: (index: number) => void;
    onSelect: (item: AIChatSlashCommand) => void;
    onClose: () => void;
}

export function AIChatCommandPicker({
    open,
    selectedIndex,
    items,
    anchorElement,
    onHoverIndex,
    onSelect,
    onClose,
}: AIChatCommandPickerProps) {
    const ref = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const position = useComposerPickerPosition(
        anchorElement,
        ref.current,
        open,
        items.length,
    );

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
                top: position?.y ?? 8,
                left: position?.x ?? 8,
                zIndex: 10010,
                width: position?.width ?? 320,
                maxHeight: position?.maxHeight ?? 360,
                overflow: "hidden",
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
                background:
                    "color-mix(in srgb, var(--bg-elevated) 97%, transparent)",
                boxShadow:
                    "0 12px 32px rgba(15, 23, 42, 0.16), 0 0 0 1px color-mix(in srgb, var(--border) 40%, transparent)",
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
                    maxHeight: position?.maxHeight ?? 360,
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
                                    padding: "7px 10px",
                                    textAlign: "left",
                                    cursor: "pointer",
                                    width: "100%",
                                    minWidth: 0,
                                    transition: "background-color 80ms ease",
                                }}
                            >
                                <CommandIcon />
                                <span
                                    style={{
                                        color: "var(--text-primary)",
                                        fontFamily: "var(--font-mono, monospace)",
                                        fontSize: 12.5,
                                        fontWeight: 500,
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        flex: "0 0 auto",
                                        maxWidth: "44%",
                                        minWidth: 0,
                                    }}
                                >
                                    {item.label}
                                </span>
                                <span
                                    style={{
                                        fontSize: 11.5,
                                        color: "var(--text-secondary)",
                                        opacity: 0.6,
                                        flex: "1 1 0",
                                        minWidth: 0,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
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
