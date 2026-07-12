import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import type { AIMentionSuggestion } from "../types";
import { useComposerPickerPosition } from "./useComposerPickerPosition";

function suggestionKey(item: AIMentionSuggestion) {
    if (item.kind === "fetch") return "fetch";
    if (item.kind === "plan") return "plan";
    if (item.kind === "note") return `note:${item.note.id}`;
    if (item.kind === "file") return `file:${item.file.path}`;
    return `folder:${item.folderPath}`;
}

function getSuggestionSecondary(item: AIMentionSuggestion) {
    if (item.kind === "fetch") return "Web search";
    if (item.kind === "plan") return "Planning";
    if (item.kind === "file") {
        return getParentDirectoryLabel(item.file.relativePath);
    }
    if (item.kind === "note") {
        return getParentDirectoryLabel(item.note.id || item.note.path);
    }
    return getParentDirectoryLabel(item.folderPath);
}

function getParentDirectoryLabel(path: string) {
    const lastSlashIndex = path.lastIndexOf("/");
    return lastSlashIndex < 0 ? "" : path.slice(0, lastSlashIndex);
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
            style={{ color: "var(--text-secondary)", opacity: 0.72 }}
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
    selectedIndex: number;
    items: AIMentionSuggestion[];
    anchorElement: HTMLElement | null;
    onHoverIndex: (index: number) => void;
    onSelect: (item: AIMentionSuggestion) => void;
    onClose: () => void;
}

export function AIChatMentionPicker({
    open,
    selectedIndex,
    items,
    anchorElement,
    onHoverIndex,
    onSelect,
    onClose,
}: AIChatMentionPickerProps) {
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
                        const isFetch = item.kind === "fetch";
                        const isPlan = item.kind === "plan";
                        const secondary = getSuggestionSecondary(item);
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
                                        ? "color-mix(in srgb, var(--accent) 14%, var(--bg-primary))"
                                        : "transparent",
                                    padding: "5px 10px",
                                    textAlign: "left",
                                    cursor: "pointer",
                                    width: "100%",
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
                                ) : item.kind === "file" ? (
                                    <FileTypeIcon
                                        fileName={item.file.fileName}
                                        mimeType={item.file.mimeType}
                                        opacity={isActive ? 0.92 : 0.6}
                                        size={14}
                                    />
                                ) : (
                                    <FileTypeIcon
                                        fileName={
                                            item.note.path.split("/").pop() ??
                                            item.note.title
                                        }
                                        mimeType="text/markdown"
                                        opacity={isActive ? 0.92 : 0.6}
                                        size={14}
                                    />
                                )}
                                <span
                                    style={{
                                        color: "var(--text-primary)",
                                        fontSize: 13,
                                        fontWeight: 400,
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
                                            : item.kind === "file"
                                              ? item.label
                                              : item.name}
                                </span>
                                {secondary ? (
                                    <span
                                        style={{
                                            fontSize: 11,
                                            color: "var(--text-secondary)",
                                            opacity: 0.6,
                                            fontFamily:
                                                "var(--font-mono, monospace)",
                                            flex: "0 1 48%",
                                            minWidth: 0,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {secondary}
                                    </span>
                                ) : null}
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
