import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../../app/utils/menuPosition";
import type { AIMentionSuggestion } from "../types";

function suggestionKey(item: AIMentionSuggestion) {
    if (item.kind === "fetch") return "fetch";
    if (item.kind === "plan") return "plan";
    return item.kind === "note"
        ? `note:${item.note.id}`
        : `folder:${item.folderPath}`;
}

function FolderIcon() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="var(--icon-muted)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
        >
            <path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
        </svg>
    );
}

function NoteIcon({ color = "var(--text-secondary)" }: { color?: string }) {
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
            style={{
                color,
                opacity: color === "var(--text-secondary)" ? 0.6 : 1,
            }}
        >
            <path d="M8 1.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5z" />
            <path d="M8 1.5V5h3.5" />
        </svg>
    );
}

function FetchIcon() {
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
            style={{ color: "#10b981" }}
        >
            <circle cx="7" cy="7" r="5.5" />
            <path d="M1.5 7h11M7 1.5a8.5 8.5 0 0 1 2 5.5 8.5 8.5 0 0 1-2 5.5M7 1.5a8.5 8.5 0 0 0-2 5.5 8.5 8.5 0 0 0 2 5.5" />
        </svg>
    );
}

function PlanIcon() {
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
            <path d="M3 3.5h8M3 7h8M3 10.5h5" />
            <circle
                cx="1.75"
                cy="3.5"
                r="0.75"
                fill="currentColor"
                stroke="none"
            />
            <circle
                cx="1.75"
                cy="7"
                r="0.75"
                fill="currentColor"
                stroke="none"
            />
            <circle
                cx="1.75"
                cy="10.5"
                r="0.75"
                fill="currentColor"
                stroke="none"
            />
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
                        const isFetch = item.kind === "fetch";
                        const isPlan = item.kind === "plan";
                        const isNote = item.kind === "note";
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
                                    gap: 8,
                                    border: "none",
                                    borderRadius: 7,
                                    background: isActive
                                        ? isFetch
                                            ? "color-mix(in srgb, #10b981 10%, var(--bg-secondary))"
                                            : isPlan
                                              ? "color-mix(in srgb, var(--accent) 12%, var(--bg-secondary))"
                                              : isNote
                                                ? "color-mix(in srgb, #d97706 10%, var(--bg-secondary))"
                                                : "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))"
                                        : "transparent",
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    cursor: "pointer",
                                    minWidth: 0,
                                    transition: "background-color 80ms ease",
                                }}
                            >
                                {isFetch ? (
                                    <FetchIcon />
                                ) : isPlan ? (
                                    <PlanIcon />
                                ) : item.kind === "folder" ? (
                                    <FolderIcon />
                                ) : (
                                    <NoteIcon color="#d97706" />
                                )}
                                <span
                                    style={{
                                        color: isFetch
                                            ? "#10b981"
                                            : isPlan
                                              ? "var(--accent)"
                                              : isNote
                                                ? "#d97706"
                                                : "var(--text-primary)",
                                        fontSize: 13,
                                        fontWeight:
                                            isFetch || isPlan || isNote
                                                ? 600
                                                : 500,
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        flex: 1,
                                        minWidth: 0,
                                    }}
                                >
                                    {isFetch
                                        ? "fetch"
                                        : isPlan
                                          ? "/plan"
                                          : item.kind === "note"
                                            ? item.label
                                            : item.name}
                                </span>
                                {(isFetch || isPlan) && (
                                    <span
                                        style={{
                                            fontSize: 11,
                                            color: "var(--text-secondary)",
                                            opacity: 0.6,
                                            flexShrink: 0,
                                        }}
                                    >
                                        {isFetch ? "web search" : "planning"}
                                    </span>
                                )}
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
                        No matches found
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}
