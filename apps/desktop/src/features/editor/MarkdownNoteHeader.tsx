import { type RefObject } from "react";
import { MetaBadge, EditableNoteTitle } from "./EditorHeader";
import { FrontmatterBody } from "./FrontmatterPanel";

export interface MarkdownNoteHeaderProps {
    /** Current editable title text */
    editableTitle: string;
    /** Callback when the user edits the title */
    onTitleChange: (nextValue: string) => void;
    /** Ref forwarded to the title textarea */
    titleInputRef?: RefObject<HTMLTextAreaElement | null>;
    /** Context menu handler for the title textarea (spellcheck) */
    onTitleContextMenu?: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
    /** Location breadcrumb (e.g. "daily / notes") — empty string hides it */
    locationParent: string;
    /** Raw frontmatter string (null if the note has no frontmatter) */
    frontmatterRaw: string | null;
    /** Callback when frontmatter is edited via Properties panel */
    onFrontmatterChange: (nextRaw: string | null) => void;
    /** Whether the Properties panel is expanded */
    propertiesExpanded: boolean;
    /** Toggle Properties panel visibility */
    onToggleProperties: () => void;
    /** Open the in-file search panel */
    onSearchClick: () => void;
}

export function MarkdownNoteHeader({
    editableTitle,
    onTitleChange,
    titleInputRef,
    onTitleContextMenu,
    locationParent,
    frontmatterRaw,
    onFrontmatterChange,
    propertiesExpanded,
    onToggleProperties,
    onSearchClick,
}: MarkdownNoteHeaderProps) {
    return (
        <div
            style={{
                maxWidth: "var(--editor-content-width)",
                margin: "0 auto",
                padding: "40px clamp(24px, 5vw, 56px) 0",
                boxSizing: "border-box",
            }}
        >
            {/* Location breadcrumb */}
            {locationParent && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                        marginBottom: 14,
                    }}
                >
                    <MetaBadge label={locationParent} />
                </div>
            )}

            {/* Title row */}
            <EditableNoteTitle
                value={editableTitle}
                onChange={onTitleChange}
                textareaRef={titleInputRef}
                onContextMenu={onTitleContextMenu}
            />

            {/* Toolbar: Properties toggle + Search */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    marginTop: 12,
                    marginBottom: 8,
                }}
            >
                <ToolbarButton
                    label="Properties"
                    icon={<PropertiesIcon />}
                    active={propertiesExpanded}
                    onClick={onToggleProperties}
                />
                <ToolbarButton
                    label="Search"
                    icon={<SearchIcon />}
                    onClick={onSearchClick}
                />
            </div>

            {/* Properties body (expanded below toolbar) */}
            {propertiesExpanded && (
                <div style={{ marginBottom: 8 }}>
                    <FrontmatterBody
                        raw={frontmatterRaw}
                        onChange={onFrontmatterChange}
                    />
                </div>
            )}
        </div>
    );
}

/* ── tiny toolbar button ──────────────────────────────────── */

function ToolbarButton({
    label,
    icon,
    active = false,
    onClick,
}: {
    label: string;
    icon: React.ReactNode;
    active?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            title={label}
            onClick={onClick}
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 28,
                padding: "0 10px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 500,
                color: active ? "var(--accent)" : "var(--text-secondary)",
                background: active
                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                    : "transparent",
                transition: "background 120ms, color 120ms",
            }}
            onMouseEnter={(e) => {
                if (!active) {
                    e.currentTarget.style.background =
                        "color-mix(in srgb, var(--text-secondary) 8%, transparent)";
                }
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.background = active
                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                    : "transparent";
            }}
        >
            {icon}
            {label}
        </button>
    );
}

/* ── inline SVG icons (16×16) ─────────────────────────────── */

function PropertiesIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M2 4h12M2 8h8M2 12h10" />
        </svg>
    );
}

function SearchIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
        </svg>
    );
}
