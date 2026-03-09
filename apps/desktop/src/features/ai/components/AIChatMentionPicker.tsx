import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../../app/utils/menuPosition";
import type { AIMentionSuggestion } from "../types";

function suggestionKey(item: AIMentionSuggestion) {
    return item.kind === "note" ? `note:${item.note.id}` : `folder:${item.folderPath}`;
}

function suggestionTitle(item: AIMentionSuggestion) {
    return item.kind === "note" ? item.note.title : item.name;
}

function suggestionSubtitle(item: AIMentionSuggestion) {
    return item.kind === "note" ? item.note.path : item.folderPath;
}

function FolderIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            style={{ color: "var(--text-secondary)", opacity: 0.7 }}
        >
            <path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
        </svg>
    );
}

function NoteIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            style={{ color: "var(--text-secondary)", opacity: 0.7 }}
        >
            <path d="M8 1.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5z" />
            <path d="M8 1.5V5h3.5" />
        </svg>
    );
}

interface AIChatMentionPickerProps {
    open: boolean;
    x: number;
    y: number;
    query: string;
    selectedIndex: number;
    items: AIMentionSuggestion[];
    anchorElement: HTMLElement | null;
    onHoverIndex: (index: number) => void;
    onSelect: (item: AIMentionSuggestion) => void;
    onClose: () => void;
}

export function AIChatMentionPicker({
    open,
    x,
    y,
    query,
    selectedIndex,
    items,
    anchorElement,
    onHoverIndex,
    onSelect,
    onClose,
}: AIChatMentionPickerProps) {
    const ref = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [position, setPosition] = useState({ x, y });

    useLayoutEffect(() => {
        if (!open) return;
        const element = ref.current;
        if (!element) return;

        const rect = element.getBoundingClientRect();
        setPosition(getViewportSafeMenuPosition(x, y - rect.height - 8, rect.width, rect.height));
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
                width: 360,
                maxWidth: "min(360px, calc(100vw - 24px))",
                maxHeight: 320,
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
                {query.trim() ? `Attach "${query.trim()}"` : "Attach note or folder"}
            </div>
            <div
                style={{
                    overflowY: "auto",
                    padding: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    maxHeight: 260,
                }}
            >
                {items.length ? (
                    items.map((item, index) => {
                        const isActive = index === selectedIndex;
                        return (
                            <button
                                key={suggestionKey(item)}
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
                                    alignItems: "center",
                                    gap: 10,
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
                                {item.kind === "folder" ? <FolderIcon /> : <NoteIcon />}
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div
                                        style={{
                                            color: "var(--text-primary)",
                                            fontSize: 14,
                                            fontWeight: 600,
                                            lineHeight: 1.3,
                                        }}
                                    >
                                        {suggestionTitle(item)}
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 2,
                                            color: "var(--text-secondary)",
                                            fontSize: 12,
                                            lineHeight: 1.35,
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                        }}
                                    >
                                        {suggestionSubtitle(item)}
                                    </div>
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
                        No matches found
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}
