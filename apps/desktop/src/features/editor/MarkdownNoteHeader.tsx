import { useMemo, useRef, useState, type RefObject } from "react";
import { MetaBadge, EditableNoteTitle } from "./EditorHeader";
import {
    FrontmatterBody,
    parseFrontmatterRaw,
    serializeFrontmatterRaw,
    type FrontmatterEntry,
} from "./FrontmatterPanel";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import {
    KNOWN_STATUSES,
    normalizeDocumentStatus,
    statusDotColor,
    statusLabel,
    statusTone,
} from "../okf/status";
import { fetchSystemUsername } from "../okf/systemUsername";
import { useVaultStore } from "../../app/store/vaultStore";
import { upsertFrontmatterTitle } from "./noteTitleHelpers";

/** Statuses that warrant a trust banner, with their banner copy. */
const BANNER_COPY: Record<string, string> = {
    draft: "Draft — this document has not been published.",
    in_review: "In review — content may change before publication.",
    deprecated: "Deprecated — this document is outdated.",
    archived: "Archived — kept for reference only.",
};

export interface MarkdownNoteHeaderProps {
    /** Current editable title text */
    editableTitle: string;
    /** Whether the editor is using wrapped document layout */
    lineWrapping: boolean;
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
    lineWrapping,
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
    const entries = useMemo<FrontmatterEntry[]>(
        () => (frontmatterRaw ? parseFrontmatterRaw(frontmatterRaw) : []),
        [frontmatterRaw],
    );

    const rawStatus = useMemo(() => {
        const entry = entries.find((e) => e.key.toLowerCase() === "status");
        return entry && typeof entry.value === "string" ? entry.value : null;
    }, [entries]);
    const status = useMemo(
        () => normalizeDocumentStatus(rawStatus),
        [rawStatus],
    );

    const typeValue = useMemo(() => {
        const entry = entries.find((e) => e.key.toLowerCase() === "type");
        const value =
            entry && typeof entry.value === "string" ? entry.value.trim() : "";
        return value || null;
    }, [entries]);

    const okfVersion = useVaultStore((s) => s.okfVersion);
    // Conformance hint: OKF vaults expect a `type` field. Only nudge when we
    // know this is an OKF vault and the note is missing a non-empty type.
    const showMissingTypeHint = okfVersion !== null && typeValue === null;

    const [statusMenu, setStatusMenu] = useState<ContextMenuState | null>(null);

    // Latest-prop mirror so async handlers (setStatus awaits the username
    // IPC) always read the freshest frontmatter, never a stale render
    // capture. Assigned during render on purpose; it is a pure mirror.
    const frontmatterRawRef = useRef(frontmatterRaw);
    frontmatterRawRef.current = frontmatterRaw;

    const openStatusMenu = (event: React.MouseEvent<HTMLElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setStatusMenu({ x: rect.left, y: rect.bottom + 4, payload: undefined });
    };

    const setStatus = async (next: string | null) => {
        // Resolve attribution BEFORE reading the frontmatter. The username
        // fetch awaits an IPC round-trip, and a newer raw can land during
        // that await (autosave response, external sync). Computing the change
        // from render-captured entries here used to clobber keys that only
        // existed in the fresher raw, e.g. a just-added title.
        const username = next === null ? null : await fetchSystemUsername();

        const currentRaw = frontmatterRawRef.current;
        const current = currentRaw ? parseFrontmatterRaw(currentRaw) : [];

        // Preserve every other key and its order. Only touch `status` and
        // its attribution key `status_by`.
        let nextEntries: FrontmatterEntry[];
        if (next === null) {
            // Removing the status also removes its attribution.
            nextEntries = current.filter((e) => {
                const key = e.key.toLowerCase();
                return key !== "status" && key !== "status_by";
            });
        } else {
            if (current.some((e) => e.key.toLowerCase() === "status")) {
                nextEntries = current.map((e) =>
                    e.key.toLowerCase() === "status"
                        ? { ...e, value: next }
                        : e,
                );
            } else {
                nextEntries = [...current, { key: "status", value: next }];
            }

            // When the username cannot be determined, omit the field instead
            // of writing a junk value (any existing attribution is left
            // untouched).
            if (username) {
                if (
                    nextEntries.some((e) => e.key.toLowerCase() === "status_by")
                ) {
                    nextEntries = nextEntries.map((e) =>
                        e.key.toLowerCase() === "status_by"
                            ? { ...e, value: username }
                            : e,
                    );
                } else {
                    const statusIndex = nextEntries.findIndex(
                        (e) => e.key.toLowerCase() === "status",
                    );
                    nextEntries = [
                        ...nextEntries.slice(0, statusIndex + 1),
                        { key: "status_by", value: username },
                        ...nextEntries.slice(statusIndex + 1),
                    ];
                }
            }
        }
        const nextRaw = serializeFrontmatterRaw(nextEntries);

        // When this status change creates the frontmatter block from scratch,
        // seed it with the note's title (the same derived title the header
        // shows) so the new block is `title` + `status`, not `status` alone.
        // Existing frontmatter is left untouched beyond the status key.
        if (!currentRaw && next !== null && nextRaw) {
            onFrontmatterChange(upsertFrontmatterTitle(nextRaw, editableTitle));
            return;
        }

        onFrontmatterChange(nextRaw);
    };

    const bannerCopy = status ? BANNER_COPY[status] : undefined;

    return (
        <div
            data-editor-note-header="true"
            data-line-wrapping={String(lineWrapping)}
            style={{
                width: "100%",
                padding: "40px var(--editor-horizontal-inset) 0",
                boxSizing: "border-box",
            }}
        >
            <div
                data-editor-note-header-inner="true"
                style={{
                    width: lineWrapping
                        ? "min(100%, var(--editor-content-width))"
                        : "100%",
                    maxWidth: lineWrapping
                        ? "var(--editor-content-width)"
                        : "none",
                    minWidth: 0,
                    margin: lineWrapping ? "0 auto" : "0",
                }}
            >
                {/* Location breadcrumb + OKF status / type badges */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                        minWidth: 0,
                        marginBottom: 14,
                    }}
                >
                    {locationParent && <MetaBadge label={locationParent} />}
                    {status ? (
                        <MetaBadge
                            label={statusLabel(status)}
                            tone={statusTone(status)}
                            title="Change status"
                            onClick={openStatusMenu}
                            leading={
                                <StatusDot color={statusDotColor(status)} />
                            }
                        />
                    ) : (
                        <SetStatusButton onClick={openStatusMenu} />
                    )}
                    {typeValue && <MetaBadge label={typeValue} tone="muted" />}
                    {showMissingTypeHint && (
                        <MetaBadge
                            label="No OKF type"
                            tone="muted"
                            title="OKF vaults expect a type field in frontmatter"
                            onClick={() => {
                                if (!propertiesExpanded) onToggleProperties();
                            }}
                        />
                    )}
                </div>

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
                        flexWrap: "wrap",
                        minWidth: 0,
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

                {/* Trust banner (draft / in_review / deprecated / archived) */}
                {status && bannerCopy && (
                    <TrustBanner status={status} copy={bannerCopy} />
                )}

                {/* Properties body (expanded below toolbar) */}
                {propertiesExpanded && (
                    <div style={{ minWidth: 0, marginBottom: 8 }}>
                        <FrontmatterBody
                            raw={frontmatterRaw}
                            onChange={onFrontmatterChange}
                        />
                    </div>
                )}
            </div>

            {statusMenu && (
                <ContextMenu
                    menu={statusMenu}
                    onClose={() => setStatusMenu(null)}
                    minWidth={160}
                    entries={[
                        ...KNOWN_STATUSES.map((s) => ({
                            label: statusLabel(s),
                            action: () => void setStatus(s),
                        })),
                        { type: "separator" as const },
                        {
                            label: "No status",
                            action: () => void setStatus(null),
                            danger: true,
                        },
                    ]}
                />
            )}
        </div>
    );
}

/* ── OKF status UI ─────────────────────────────────────────── */

function StatusDot({ color }: { color: string }) {
    return (
        <span
            aria-hidden="true"
            style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
            }}
        />
    );
}

function SetStatusButton({
    onClick,
}: {
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title="Set status"
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 24,
                padding: "0 8px",
                borderRadius: 2,
                border: "1px dashed color-mix(in srgb, var(--border) 90%, transparent)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                cursor: "pointer",
                opacity: 0.7,
            }}
        >
            <StatusDot color="var(--text-secondary)" />
            Set status
        </button>
    );
}

function TrustBanner({ status, copy }: { status: string; copy: string }) {
    const base = statusDotColor(status);
    return (
        <div
            role="note"
            data-status-banner={status}
            style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                boxSizing: "border-box",
                padding: "6px 10px",
                marginBottom: 8,
                borderRadius: 4,
                border: `1px solid color-mix(in srgb, ${base} 22%, var(--border))`,
                background: `color-mix(in srgb, ${base} 10%, transparent)`,
                color: "var(--text-secondary)",
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1.4,
            }}
        >
            <StatusDot color={base} />
            <span>{copy}</span>
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
