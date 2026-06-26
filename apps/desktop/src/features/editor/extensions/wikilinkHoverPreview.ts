import {
    EditorView,
    hoverTooltip,
    keymap,
    showTooltip,
    type Tooltip,
} from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { findWikilinkAtPosition } from "./wikilinks";
import {
    extractSection,
    findPreviewNote,
    getNotePreviewContentState,
    loadNotePreviewContent,
    renderEmbedPreview,
} from "./notePreviewSource";
import { findWikilinkResource } from "../wikilinkResolution";
import { navigateWikilink } from "../wikilinkNavigation";
import { useVaultStore } from "../../../app/store/vaultStore";

// Default delay before the hover preview opens. Long enough to avoid firing on
// every sweep of the mouse across links.
export const DEFAULT_WIKILINK_HOVER_DELAY_MS = 300;

// Lines of the target note to show in the floating preview. Bounded so large
// notes never load or render in full just for a hover.
const HOVER_MAX_LINES = 8;

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
const PDF_FILE_RE = /\.pdf$/i;

/** Split a wikilink target into its note part and optional `#section`. */
function parseWikilinkTarget(target: string): {
    base: string;
    section: string | null;
} {
    const hashIndex = target.indexOf("#");
    if (hashIndex < 0) return { base: target.trim(), section: null };
    return {
        base: target.slice(0, hashIndex).trim(),
        section: target.slice(hashIndex + 1).trim() || null,
    };
}

/** Human label + display name for a non-markdown file target. */
function describeFileTarget(relativePath: string): {
    type: string;
    name: string;
} {
    const name = relativePath.split("/").pop() || relativePath;
    if (PDF_FILE_RE.test(relativePath)) return { type: "PDF", name };
    if (IMAGE_FILE_RE.test(relativePath)) return { type: "Image", name };
    return { type: "File", name };
}

/**
 * Resolve a wikilink target to a non-note file entry in the vault store.
 * Covers PDFs and images, which the note/text-file resolver does not surface.
 */
function findVaultFileEntry(base: string): { relativePath: string } | null {
    const normalized = base.replace(/\\/g, "/").replace(/^\/+/, "");
    const entry = useVaultStore
        .getState()
        .entries.find(
            (candidate) =>
                (candidate.kind === "file" || candidate.kind === "pdf") &&
                (candidate.relative_path === normalized ||
                    candidate.file_name === base),
        );
    return entry ? { relativePath: entry.relative_path } : null;
}

const hoverTheme = EditorView.baseTheme({
    ".cm-tooltip:has(.cm-wikilink-hover)": {
        border: "1px solid var(--border)",
        borderRadius: "8px",
        backgroundColor: "var(--bg-elevated, var(--bg-secondary))",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
        maxWidth: "420px",
        overflow: "hidden",
    },
    ".cm-wikilink-hover": {
        padding: "10px 12px",
        font: "inherit",
        color: "var(--text-primary)",
        lineHeight: "1.4",
    },
    ".cm-wikilink-hover-title": {
        fontWeight: "700",
        color: "var(--text-primary)",
        marginBottom: "4px",
    },
    ".cm-wikilink-hover-meta": {
        color: "var(--text-secondary)",
        fontSize: "0.82em",
    },
    ".cm-wikilink-hover-action": {
        cursor: "pointer",
        color: "var(--accent)",
    },
    ".cm-wikilink-hover-body": {
        fontSize: "0.88em",
        color: "var(--text-secondary)",
        lineHeight: "1.5",
    },
    ".cm-wikilink-hover-body > div": {
        marginBottom: "2px",
    },
    ".cm-wikilink-hover-body .cm-note-embed-h1, .cm-wikilink-hover-body .cm-note-embed-h2, .cm-wikilink-hover-body .cm-note-embed-h3, .cm-wikilink-hover-body .cm-note-embed-h4, .cm-wikilink-hover-body .cm-note-embed-h5, .cm-wikilink-hover-body .cm-note-embed-h6":
        {
            fontWeight: "600",
            color: "var(--text-primary)",
        },
    ".cm-wikilink-hover-body .cm-note-embed-h1": { fontSize: "1.15em" },
    ".cm-wikilink-hover-body .cm-note-embed-h2": { fontSize: "1.08em" },
    ".cm-wikilink-hover-body .cm-note-embed-li": {
        paddingLeft: "1.2em",
        position: "relative",
    },
    ".cm-wikilink-hover-body .cm-note-embed-li::before": {
        content: '"\\2022"',
        position: "absolute",
        left: "0.3em",
        color: "var(--text-secondary)",
    },
    ".cm-wikilink-hover-body code": {
        fontSize: "0.9em",
        padding: "1px 4px",
        borderRadius: "3px",
        background:
            "color-mix(in srgb, var(--bg-tertiary) 60%, var(--bg-primary))",
    },
    ".cm-wikilink-hover-body .cm-note-embed-wikilink": {
        color: "var(--accent)",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: "2px",
    },
});

/**
 * Build the hover tooltip for a document position, or null when the position
 * is not inside a wikilink. Exposed separately so the trigger logic can be unit
 * tested without simulating real mouse hover and timers.
 */
export function buildWikilinkHoverTooltip(
    view: EditorView,
    pos: number,
): Tooltip | null {
    const match = findWikilinkAtPosition(view, pos);
    if (!match || !match.target) return null;

    const { base, section } = parseWikilinkTarget(match.target);
    if (!base) return null;

    return {
        pos: match.from,
        end: match.to,
        above: true,
        arrow: false,
        create() {
            const dom = document.createElement("div");
            dom.className = "cm-wikilink-hover";

            const title = document.createElement("div");
            title.className = "cm-wikilink-hover-title";
            dom.appendChild(title);

            const body = document.createElement("div");
            body.className = "cm-wikilink-hover-body";
            dom.appendChild(body);

            // Track teardown so an async load can't repaint a tooltip
            // CodeMirror has already closed.
            let active = true;

            const setTitle = (name: string) => {
                title.textContent = section ? `${name} > ${section}` : name;
            };

            const showMeta = (text: string, onClick?: () => void) => {
                const meta = document.createElement("div");
                meta.className = "cm-wikilink-hover-meta";
                meta.textContent = text;
                if (onClick) {
                    meta.classList.add("cm-wikilink-hover-action");
                    // mousedown (not click) so the action fires before the
                    // tooltip closes, without stealing editor focus.
                    meta.addEventListener("mousedown", (event) => {
                        event.preventDefault();
                        onClick();
                    });
                }
                body.replaceChildren(meta);
            };

            // Render note content, narrowing to a `#section` when present.
            const renderNoteContent = (content: string) => {
                const text = section
                    ? extractSection(content, section)
                    : content;
                if (text.trim()) {
                    body.replaceChildren(
                        renderEmbedPreview(text, HOVER_MAX_LINES),
                    );
                    return;
                }
                showMeta(section ? "Section not found" : "Empty note");
            };

            const loadNoteContent = (noteId: string) => {
                showMeta("Loading…");
                void loadNotePreviewContent(noteId).then((content) => {
                    if (!active) return;
                    if (content === null) {
                        showMeta("Could not load note");
                        return;
                    }
                    renderNoteContent(content);
                });
            };

            // Fast path: target is a markdown note already in the vault store.
            const note = findPreviewNote(base);
            if (note) {
                setTitle(note.title);
                const { content, load } = getNotePreviewContentState(
                    note,
                    base,
                );
                if (content !== null) {
                    renderNoteContent(content);
                } else if (load) {
                    showMeta("Loading…");
                    void load().then((loaded) => {
                        if (!active) return;
                        if (loaded === null) {
                            showMeta("Could not load note");
                            return;
                        }
                        renderNoteContent(loaded);
                    });
                }
                return {
                    dom,
                    destroy() {
                        active = false;
                    },
                };
            }

            // Non-note file already known to the vault (PDF, image, etc.).
            const fileEntry = findVaultFileEntry(base);
            if (fileEntry) {
                const { type, name } = describeFileTarget(
                    fileEntry.relativePath,
                );
                title.textContent = name;
                showMeta(type);
                return {
                    dom,
                    destroy() {
                        active = false;
                    },
                };
            }

            // Otherwise resolve the target type: note, file, or unresolved.
            setTitle(base);
            showMeta("Loading…");
            void findWikilinkResource(base).then((resource) => {
                if (!active) return;
                if (resource?.kind === "note") {
                    setTitle(resource.title ?? base);
                    loadNoteContent(resource.id);
                    return;
                }
                if (resource?.kind === "file") {
                    const { type, name } = describeFileTarget(
                        resource.relativePath,
                    );
                    title.textContent = name;
                    showMeta(type);
                    return;
                }
                showMeta("No note yet — click to create", () => {
                    void navigateWikilink(base);
                });
            });

            return {
                dom,
                destroy() {
                    active = false;
                },
            };
        },
    };
}

// --- Keyboard accessibility: preview the link under the caret on demand ---

const setCaretPreviewTooltip = StateEffect.define<Tooltip | null>();

// Holds the on-demand (keyboard-triggered) preview tooltip. It dismisses itself
// as soon as the user edits or moves the caret, so it never lingers stale.
const caretPreviewField = StateField.define<Tooltip | null>({
    create() {
        return null;
    },
    update(value, tr) {
        let next = value;
        for (const effect of tr.effects) {
            if (effect.is(setCaretPreviewTooltip)) next = effect.value;
        }
        if (next && next === value && (tr.docChanged || tr.selection)) {
            return null;
        }
        return next;
    },
    provide: (field) => showTooltip.from(field),
});

/**
 * Open the note preview for the wikilink under the caret. Keyboard-equivalent
 * of hovering, so the feature is reachable without a mouse. Returns false when
 * the caret is not inside a wikilink.
 */
export function showWikilinkPreviewAtCaret(view: EditorView): boolean {
    const tooltip = buildWikilinkHoverTooltip(
        view,
        view.state.selection.main.head,
    );
    if (!tooltip) return false;
    view.dispatch({ effects: setCaretPreviewTooltip.of(tooltip) });
    return true;
}

const caretPreviewKeymap = keymap.of([
    {
        key: "Escape",
        run(view) {
            if (view.state.field(caretPreviewField, false)) {
                view.dispatch({ effects: setCaretPreviewTooltip.of(null) });
                return true;
            }
            return false;
        },
    },
]);

/**
 * Show a floating preview when hovering over a `[[wikilink]]`, plus a
 * keyboard-triggered preview for the link under the caret.
 */
export function wikilinkHoverPreviewExtension(
    hoverTime: number = DEFAULT_WIKILINK_HOVER_DELAY_MS,
) {
    const tooltip = hoverTooltip(buildWikilinkHoverTooltip, { hoverTime });
    return [tooltip, caretPreviewField, caretPreviewKeymap, hoverTheme];
}
