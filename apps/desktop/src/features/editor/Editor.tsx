import {
    useEffect,
    useRef,
    useCallback,
    useState,
    useLayoutEffect,
    type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { EditorView, keymap } from "@codemirror/view";
import {
    ChangeSet,
    EditorSelection,
    EditorState,
    Compartment,
} from "@codemirror/state";
import {
    history,
    defaultKeymap,
    historyKeymap,
    indentMore,
    indentLess,
} from "@codemirror/commands";
import {
    search,
    searchKeymap,
    openSearchPanel,
    closeSearchPanel,
    searchPanelOpen,
} from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
    indentUnit,
    syntaxHighlighting,
    defaultHighlightStyle,
} from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShallow } from "zustand/react/shallow";
import { getWindowMode } from "../../app/detachedWindows";
import { findWikilinks } from "../../app/utils/wikilinks";
import {
    useEditorStore,
    type Tab,
    type EditorMode,
} from "../../app/store/editorStore";
import { useThemeStore } from "../../app/store/themeStore";
import {
    useSettingsStore,
    type EditorFontFamily,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { wikilinkExtension } from "./extensions/wikilinks";
import { urlLinksExtension } from "./extensions/urlLinks";
import { searchTheme } from "./extensions/searchTheme";
import { livePreviewExtension } from "./extensions/livePreview";
import {
    FrontmatterPanel,
    parseFrontmatterRaw,
    serializeFrontmatterRaw,
    type FrontmatterEntry,
} from "./FrontmatterPanel";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;
const appWindow = getCurrentWindow();

type VaultNote = ReturnType<typeof useVaultStore.getState>["notes"][number];
type SavedNoteDetail = {
    id: string;
    path: string;
    title: string;
    content: string;
};

let cachedNotesRef: VaultNote[] | null = null;
let cachedWikilinkIndex: Map<string, VaultNote> | null = null;
let cachedWikilinkResolution: Map<string, VaultNote | null> | null = null;

function normalizeWikilinkTarget(target: string): string {
    const trimmed = target.trim();
    const withoutSubpath = trimmed.split(/[#^]/, 1)[0]?.trim() ?? "";
    return withoutSubpath
        .replace(/\.md$/i, "")
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/…/g, "...")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function getWikilinkVariants(target: string): string[] {
    const normalized = normalizeWikilinkTarget(target);
    if (!normalized) return [];
    const trimmed = normalized.replace(/[\s.,!?:;]+$/g, "");
    return trimmed && trimmed !== normalized
        ? [normalized, trimmed]
        : [normalized];
}

function isStrongPrefixCandidate(target: string): boolean {
    return target.length >= 24 && target.split(/\s+/).length >= 4;
}

function isPrefixExpansion(candidate: string, target: string): boolean {
    if (candidate === target || !candidate.startsWith(target)) {
        return false;
    }

    const next = candidate.charAt(target.length);
    return next === " " || next === "-" || next === ":" || next === "(";
}

function findUniquePrefixNote(
    target: string,
    notes: VaultNote[],
): VaultNote | null {
    const variants = getWikilinkVariants(target).filter(
        isStrongPrefixCandidate,
    );
    if (!variants.length) return null;

    const matches: VaultNote[] = [];

    for (const note of notes) {
        const aliases = [
            normalizeWikilinkTarget(note.title),
            normalizeWikilinkTarget(note.id.split("/").pop() ?? ""),
        ];

        if (
            !aliases.some((alias) =>
                variants.some((variant) => isPrefixExpansion(alias, variant)),
            )
        ) {
            continue;
        }

        matches.push(note);
        if (matches.length > 1) return null;
    }

    return matches[0] ?? null;
}

function getWikilinkIndex(): Map<string, VaultNote> {
    const notes = useVaultStore.getState().notes;
    if (cachedNotesRef === notes && cachedWikilinkIndex) {
        return cachedWikilinkIndex;
    }

    const index = new Map<string, VaultNote>();
    for (const note of notes) {
        const fullId = normalizeWikilinkTarget(note.id);
        const title = normalizeWikilinkTarget(note.title);
        const lastSegment = normalizeWikilinkTarget(
            note.id.split("/").pop() ?? "",
        );

        for (const key of getWikilinkVariants(fullId)) {
            if (!index.has(key)) index.set(key, note);
        }
        for (const key of getWikilinkVariants(title)) {
            if (!index.has(key)) index.set(key, note);
        }
        for (const key of getWikilinkVariants(lastSegment)) {
            if (!index.has(key)) index.set(key, note);
        }
    }

    cachedNotesRef = notes;
    cachedWikilinkIndex = index;
    cachedWikilinkResolution = new Map();
    return index;
}

function findNoteByWikilink(target: string) {
    const notes = useVaultStore.getState().notes;
    const index = getWikilinkIndex();
    if (cachedNotesRef !== notes || !cachedWikilinkResolution) {
        cachedNotesRef = notes;
        cachedWikilinkResolution = new Map();
    }
    const variants = getWikilinkVariants(target);
    const cacheKey = variants.join("\u0000");
    const cachedMatch = cachedWikilinkResolution.get(cacheKey);
    if (cachedMatch !== undefined) {
        return cachedMatch;
    }

    let resolved: VaultNote | null = null;
    for (const key of variants) {
        const match = index.get(key);
        if (match) {
            resolved = match;
            break;
        }
    }

    if (!resolved) {
        resolved = findUniquePrefixNote(target, notes);
    }

    cachedWikilinkResolution.set(cacheKey, resolved);
    return resolved;
}

function resolveWikilink(target: string): boolean {
    return findNoteByWikilink(target) !== null;
}

function matchesRevealTarget(target: string, revealTargets: string[]) {
    const targetVariants = new Set(getWikilinkVariants(target));
    return revealTargets.some((candidate) =>
        getWikilinkVariants(candidate).some((variant) =>
            targetVariants.has(variant),
        ),
    );
}

function navigateWikilink(target: string) {
    const note = findNoteByWikilink(target);
    if (note) {
        const { tabs, openNote } = useEditorStore.getState();
        const existing = tabs.find((t) => t.noteId === note.id);
        if (existing) {
            openNote(note.id, note.title, existing.content);
            return;
        }
        void invoke<{ content: string }>("read_note", { noteId: note.id })
            .then((detail) => {
                useEditorStore
                    .getState()
                    .openNote(note.id, note.title, detail.content);
            })
            .catch((e) => console.error("Error reading linked note:", e));
    } else {
        // Broken link: create the note
        const { createNote } = useVaultStore.getState();
        void createNote(target).then((created) => {
            if (created) {
                useEditorStore
                    .getState()
                    .openNote(created.id, created.title, "");
            }
        });
    }
}

// Base theme using CSS variables — responds to dark/light via CSS class toggle
const baseTheme = EditorView.theme({
    "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--text-primary)",
        fontSize: "var(--editor-font-size)",
        fontFamily: "var(--editor-font-family)",
    },
    ".cm-scroller": {
        overflow: "hidden auto",
        fontFamily: "inherit",
        flexWrap: "wrap",
        paddingBottom: "72px",
        scrollbarColor: "var(--border) transparent",
        minWidth: 0,
    },
    ".cm-lp-scroll-header": {
        flex: "0 0 100%",
        boxSizing: "border-box",
    },
    ".cm-content": {
        flex: "1 1 0%",
        minWidth: 0,
        boxSizing: "border-box",
        padding:
            "24px max(clamp(24px, 5vw, 56px), calc((100% - var(--editor-content-width)) / 2)) 120px",
        caretColor: "var(--text-primary)",
        lineHeight: "1.75",
        minHeight: "calc(100vh - 220px)",
    },
    ".cm-line": {
        padding: "0 2px",
    },
    ".cm-gutters": {
        display: "none",
    },
    ".cm-cursor": {
        borderLeftColor: "var(--text-primary)",
        borderLeftWidth: "1.6px",
        marginLeft: "-0.8px",
        marginTop: "0.14em",
        marginBottom: "0.14em",
    },
    ".cm-selectionBackground, ::selection": {
        backgroundColor:
            "color-mix(in srgb, var(--accent) 22%, transparent) !important",
    },
    ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--accent) 3.5%, transparent)",
        borderRadius: "8px",
    },
    ".cm-activeLineGutter": {
        backgroundColor: "transparent",
    },
    "&.cm-focused": {
        outline: "none",
    },
});

// Compartment for syntax highlighting (switches between dark/light)
const syntaxCompartment = new Compartment();
// Compartment for the editor rendering mode (fixed to live preview)
const livePreviewCompartment = new Compartment();
// Compartment for justified alignment
const alignmentCompartment = new Compartment();
// Compartment for tab size
const tabSizeCompartment = new Compartment();

const MARKDOWN_LIST_LINE_RE = /^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

function getSelectedLines(state: EditorState) {
    const seen = new Set<number>();
    const lines: Array<ReturnType<EditorState["doc"]["line"]>> = [];

    for (const range of state.selection.ranges) {
        const startLine = state.doc.lineAt(range.from);
        let endPos = range.to;

        if (!range.empty) {
            const rawEndLine = state.doc.lineAt(range.to);
            if (range.to === rawEndLine.from && range.to > range.from) {
                endPos = range.to - 1;
            }
        }

        const endLine = state.doc.lineAt(endPos);
        for (
            let lineNumber = startLine.number;
            lineNumber <= endLine.number;
            lineNumber++
        ) {
            const line = state.doc.line(lineNumber);
            if (seen.has(line.from)) continue;
            seen.add(line.from);
            lines.push(line);
        }
    }

    return lines;
}

function getListLines(state: EditorState) {
    const lines = getSelectedLines(state);
    if (!lines.length) return null;
    if (lines.some((line) => !MARKDOWN_LIST_LINE_RE.test(line.text))) {
        return null;
    }
    return lines;
}

function mapSelectionThroughChanges(state: EditorState, changes: ChangeSet) {
    return EditorSelection.create(
        state.selection.ranges.map((range) =>
            EditorSelection.range(
                changes.mapPos(range.from, 1),
                changes.mapPos(range.to, 1),
            ),
        ),
        state.selection.mainIndex,
    );
}

function indentMarkdownListItems({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;

    const lines = getListLines(state);
    if (!lines) return false;

    const unit = state.facet(indentUnit);
    const changes = ChangeSet.of(
        lines.map((line) => ({ from: line.from, insert: unit })),
        state.doc.length,
    );

    dispatch(
        state.update({
            changes,
            selection: mapSelectionThroughChanges(state, changes),
            scrollIntoView: true,
            userEvent: "input.indent",
        }),
    );

    return true;
}

function getOutdentDeleteLength(prefix: string, maxColumns: number) {
    let consumed = 0;
    let columns = 0;

    while (consumed < prefix.length && columns < maxColumns) {
        const char = prefix[consumed];
        if (char === " ") {
            consumed++;
            columns++;
            continue;
        }
        if (char === "\t") {
            consumed++;
            break;
        }
        break;
    }

    return consumed;
}

function outdentMarkdownListItems({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;

    const lines = getListLines(state);
    if (!lines) return false;

    const unit = state.facet(indentUnit);
    const specs = lines
        .map((line) => {
            const match = line.text.match(MARKDOWN_LIST_LINE_RE);
            const prefix = match?.[1] ?? "";
            const deleteLength = getOutdentDeleteLength(prefix, unit.length);
            if (!deleteLength) return null;
            return {
                from: line.from,
                to: line.from + deleteLength,
            };
        })
        .filter((spec): spec is { from: number; to: number } => spec !== null);

    if (!specs.length) return false;

    const changes = ChangeSet.of(specs, state.doc.length);

    dispatch(
        state.update({
            changes,
            selection: mapSelectionThroughChanges(state, changes),
            scrollIntoView: true,
            userEvent: "input.indent",
        }),
    );

    return true;
}

function insertConfiguredTab({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;
    if (indentMarkdownListItems({ state, dispatch })) return true;
    if (state.selection.ranges.some((range) => !range.empty)) {
        return indentMore({ state, dispatch });
    }

    const unit = state.facet(indentUnit);
    const changes = state.changeByRange((range) => ({
        changes: { from: range.from, to: range.to, insert: unit },
        range: EditorSelection.cursor(range.from + unit.length),
    }));

    dispatch(
        state.update(changes, {
            scrollIntoView: true,
            userEvent: "input",
        }),
    );

    return true;
}

function removeConfiguredTab({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (outdentMarkdownListItems({ state, dispatch })) return true;
    return indentLess({ state, dispatch });
}

function getSyntaxExtension(isDark: boolean) {
    // Only switch syntax highlighting colors, not the full editor theme
    return isDark
        ? syntaxHighlighting(oneDarkHighlightStyle)
        : syntaxHighlighting(defaultHighlightStyle);
}

function getLivePreviewExtension(mode: EditorMode) {
    const vaultPath = useVaultStore.getState().vaultPath;
    return mode === "preview"
        ? livePreviewExtension(vaultPath, {
              resolveWikilink,
              navigateWikilink,
          })
        : [];
}

function getAlignmentExtension(enabled: boolean) {
    return enabled
        ? [
              EditorView.contentAttributes.of({
                  class: "cm-justify-text",
              }),
              EditorView.theme({
                  ".cm-content.cm-justify-text .cm-line": {
                      width: "100%",
                      textAlign: "justify",
                      textAlignLast: "left",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "break-word",
                      wordBreak: "normal",
                      hyphens: "auto",
                  },
              }),
          ]
        : [];
}

function getEditorFontFamily(fontFamily: EditorFontFamily) {
    switch (fontFamily) {
        case "sans":
            return '"Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif';
        case "serif":
            return '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif';
        case "mono":
            return '"SFMono-Regular", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace';
        case "courier":
            return '"Courier New", Courier, "Nimbus Mono PS", monospace';
        case "reading":
            return '"Charter", "Baskerville", "Georgia", serif';
        case "rounded":
            return '"SF Pro Rounded", "Nunito", "Avenir Next Rounded", "Hiragino Maru Gothic ProN", sans-serif';
        case "humanist":
            return '"Optima", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif';
        case "slab":
            return '"Rockwell", "Clarendon Text", "Roboto Slab", "Courier Prime", serif';
        case "typewriter":
            return '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace';
        case "newspaper":
            return '"Times New Roman", "Georgia", "Source Serif 4", "Iowan Old Style", serif';
        case "condensed":
            return '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif';
        case "system":
        default:
            return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    }
}

function getNoteLocation(noteId: string) {
    const parts = noteId.split("/").filter(Boolean);
    return {
        parent: parts.slice(0, -1).join(" / "),
    };
}

function extractFirstHeading(body: string): string | null {
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("# ")) {
            return trimmed.slice(2).trim();
        }
        break;
    }
    return null;
}

function deriveDisplayedTitle(
    frontmatterRaw: string | null,
    body: string,
    fallback: string,
) {
    const fmTitle = frontmatterRaw
        ? parseFrontmatterRaw(frontmatterRaw).find(
              (entry) => entry.key === "title",
          )?.value
        : null;
    if (typeof fmTitle === "string" && fmTitle.trim()) {
        return fmTitle.trim();
    }
    return extractFirstHeading(body) ?? fallback;
}

function upsertFrontmatterTitle(raw: string, title: string): string {
    const entries = parseFrontmatterRaw(raw);
    const nextEntries: FrontmatterEntry[] = [];
    let found = false;

    for (const entry of entries) {
        if (entry.key === "title") {
            nextEntries.push({ key: "title", value: title });
            found = true;
        } else {
            nextEntries.push(entry);
        }
    }

    if (!found) {
        nextEntries.unshift({ key: "title", value: title });
    }

    return (
        serializeFrontmatterRaw(nextEntries) ?? `---\ntitle: ${title}\n---\n`
    );
}

function replaceOrInsertLeadingHeading(body: string, title: string): string {
    const lines = body.split(/\r?\n/);
    const lineBreak = body.includes("\r\n") ? "\r\n" : "\n";

    for (let index = 0; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("# ")) {
            const indent = lines[index].match(/^\s*/)?.[0] ?? "";
            lines[index] = `${indent}# ${title}`;
            return lines.join(lineBreak);
        }
        break;
    }

    return `# ${title}${lineBreak}${lineBreak}${body}`.trimEnd();
}

function MetaBadge({
    label,
    tone = "muted",
}: {
    label: string;
    tone?: "muted" | "accent" | "success";
}) {
    const palette =
        tone === "accent"
            ? {
                  color: "var(--accent)",
                  background:
                      "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
                  border: "color-mix(in srgb, var(--accent) 24%, var(--border))",
              }
            : tone === "success"
              ? {
                    color: "#15803d",
                    background:
                        "color-mix(in srgb, #22c55e 10%, var(--bg-primary))",
                    border: "color-mix(in srgb, #22c55e 22%, var(--border))",
                }
              : {
                    color: "var(--text-secondary)",
                    background:
                        "color-mix(in srgb, var(--bg-secondary) 82%, transparent)",
                    border: "var(--border)",
                };

    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 28,
                padding: "0 11px",
                borderRadius: 999,
                border: `1px solid ${palette.border}`,
                background: palette.background,
                color: palette.color,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.01em",
            }}
        >
            {label}
        </span>
    );
}

function EditableNoteTitle({
    value,
    onChange,
}: {
    value: string;
    onChange: (nextValue: string) => void;
}) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        setDraft(value);
    }, [value]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = `${el.scrollHeight}px`;
    }, [draft]);

    return (
        <textarea
            ref={ref}
            value={draft}
            rows={1}
            spellCheck={false}
            onChange={(e) => {
                const nextValue = e.target.value.replace(/\r?\n+/g, " ");
                setDraft(nextValue);
                onChange(nextValue);
            }}
            style={{
                width: "100%",
                resize: "none",
                overflow: "hidden",
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: 16,
                padding: "6px 8px",
                margin: "-6px -8px 0",
                fontSize: "2rem",
                fontWeight: 750,
                color: "var(--text-primary)",
                lineHeight: 1.1,
                letterSpacing: "-0.03em",
                outline: "none",
            }}
            onFocus={(e) => {
                e.currentTarget.style.borderColor =
                    "color-mix(in srgb, var(--accent) 22%, transparent)";
                e.currentTarget.style.background =
                    "color-mix(in srgb, var(--bg-secondary) 78%, transparent)";
            }}
            onBlur={(e) => {
                e.currentTarget.style.borderColor = "transparent";
                e.currentTarget.style.background = "transparent";
            }}
        />
    );
}

interface EditorProps {
    emptyStateMessage?: string;
}

export function Editor({
    emptyStateMessage = "Open a note from the left panel",
}: EditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contentUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const activeTabRef = useRef<Tab | null>(null);
    const isInternalRef = useRef(false);
    // Save/restore full EditorState per tab (preserves undo history + scroll)
    const tabStatesRef = useRef<Map<string, EditorState>>(new Map());
    const prevTabIdRef = useRef<string | null>(null);
    // Frontmatter: stores the raw ---...--- block per tab so we can restore it on save
    const frontmatterByTabId = useRef<Map<string, string>>(new Map());
    const [activeFrontmatter, setActiveFrontmatter] = useState<string | null>(
        null,
    );
    const [editableTitle, setEditableTitle] = useState("");
    const scrollHeaderRef = useRef<HTMLDivElement | null>(null);

    // Extract and strip frontmatter from content. Stores the raw block in the ref.
    // Returns the body (content after the frontmatter block).
    const stripFrontmatter = useCallback(
        (tabId: string, content: string): string => {
            const match = content.match(FRONTMATTER_RE);
            if (!match) {
                frontmatterByTabId.current.delete(tabId);
                return content;
            }
            frontmatterByTabId.current.set(tabId, match[0]);
            return content.slice(match[0].length);
        },
        [],
    );

    const activeTabId = useEditorStore((s) => s.activeTabId);
    const editorMode = useEditorStore((s) => s.editorMode);
    const pendingReveal = useEditorStore((s) => s.pendingReveal);
    const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal);
    const pendingSelectionReveal = useEditorStore(
        (s) => s.pendingSelectionReveal,
    );
    const clearPendingSelectionReveal = useEditorStore(
        (s) => s.clearPendingSelectionReveal,
    );
    const updateTabContent = useEditorStore((s) => s.updateTabContent);
    const markTabDirty = useEditorStore((s) => s.markTabDirty);
    const updateTabTitle = useEditorStore((s) => s.updateTabTitle);
    const markTabClean = useEditorStore((s) => s.markTabClean);
    const isDark = useThemeStore((s) => s.isDark);
    const autoSave = useSettingsStore((s) => s.autoSave);
    const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const justifyText = useSettingsStore((s) => s.justifyText);
    const tabSize = useSettingsStore((s) => s.tabSize);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);

    // Only re-renders when the active tab identity changes, not on content/isDirty updates
    const activeTabInfo = useEditorStore(
        useShallow((s) => {
            const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? null;
            return tab
                ? {
                      id: tab.id,
                      title: tab.title,
                      noteId: tab.noteId,
                  }
                : null;
        }),
    );
    const activeTab =
        activeTabId === null
            ? null
            : (useEditorStore
                  .getState()
                  .tabs.find((t) => t.id === activeTabId) ?? null);
    activeTabRef.current = activeTab;

    const getCurrentBody = useCallback(() => {
        return (
            viewRef.current?.state.doc.toString() ??
            activeTabRef.current?.content ??
            ""
        );
    }, []);

    const saveNow = useCallback(
        async (tab: Tab, content: string) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            try {
                const fm = frontmatterByTabId.current.get(tab.id) ?? "";
                const detail = await invoke<SavedNoteDetail>("save_note", {
                    noteId: tab.noteId,
                    content: fm + content,
                });
                stripFrontmatter(tab.id, detail.content);
                updateTabTitle(tab.id, detail.title);
                updateNoteMetadata(tab.noteId, {
                    title: detail.title,
                    path: detail.path,
                    modified_at: Math.floor(Date.now() / 1000),
                });
                if (activeTabRef.current?.id === tab.id) {
                    setActiveFrontmatter(
                        frontmatterByTabId.current.get(tab.id) ?? null,
                    );
                    setEditableTitle(detail.title);
                }
                markTabClean(tab.id);
            } catch (e) {
                console.error("Error al guardar nota:", e);
            }
        },
        [markTabClean, stripFrontmatter, updateNoteMetadata, updateTabTitle],
    );

    const scheduleSave = useCallback(
        (tab: Tab, content: string) => {
            if (!autoSave) return;
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                saveNow(tab, content);
            }, autoSaveDelay);
        },
        [autoSave, autoSaveDelay, saveNow],
    );

    const applyFrontmatterChange = useCallback(
        (nextFrontmatter: string | null) => {
            const tab = activeTabRef.current;
            if (!tab) return;

            if (nextFrontmatter) {
                frontmatterByTabId.current.set(tab.id, nextFrontmatter);
            } else {
                frontmatterByTabId.current.delete(tab.id);
            }

            const body = getCurrentBody();
            const nextTitle = deriveDisplayedTitle(
                nextFrontmatter,
                body,
                tab.title,
            );

            setActiveFrontmatter(nextFrontmatter);
            setEditableTitle(nextTitle);
            updateTabTitle(tab.id, nextTitle);
            updateNoteMetadata(tab.noteId, {
                title: nextTitle,
                modified_at: Math.floor(Date.now() / 1000),
            });
            updateTabContent(tab.id, body);
            scheduleSave({ ...tab, title: nextTitle }, body);
        },
        [
            getCurrentBody,
            scheduleSave,
            updateNoteMetadata,
            updateTabContent,
            updateTabTitle,
        ],
    );

    const applyTitleChange = useCallback(
        (nextRawTitle: string) => {
            const tab = activeTabRef.current;
            const view = viewRef.current;
            if (!tab) return;

            const title = nextRawTitle.trim();
            if (!title) return;

            const currentFrontmatter =
                frontmatterByTabId.current.get(tab.id) ?? activeFrontmatter;
            if (currentFrontmatter) {
                applyFrontmatterChange(
                    upsertFrontmatterTitle(currentFrontmatter, title),
                );
                return;
            }

            const body = getCurrentBody();
            const nextBody = replaceOrInsertLeadingHeading(body, title);
            setEditableTitle(title);
            updateTabTitle(tab.id, title);
            updateNoteMetadata(tab.noteId, {
                title,
                modified_at: Math.floor(Date.now() / 1000),
            });

            if (view && nextBody !== body) {
                view.dispatch({
                    changes: {
                        from: 0,
                        to: view.state.doc.length,
                        insert: nextBody,
                    },
                });
                return;
            }

            updateTabContent(tab.id, nextBody);
            scheduleSave({ ...tab, title }, nextBody);
        },
        [
            activeFrontmatter,
            applyFrontmatterChange,
            getCurrentBody,
            scheduleSave,
            updateNoteMetadata,
            updateTabContent,
            updateTabTitle,
        ],
    );

    // Factory to create a fresh EditorState with all extensions
    const createEditorState = useCallback(
        (doc: string) => {
            return EditorState.create({
                doc,
                extensions: [
                    history(),
                    markdown({ base: markdownLanguage }),
                    baseTheme,
                    syntaxCompartment.of(
                        getSyntaxExtension(useThemeStore.getState().isDark),
                    ),
                    EditorView.lineWrapping,
                    alignmentCompartment.of(
                        getAlignmentExtension(
                            useSettingsStore.getState().justifyText,
                        ),
                    ),
                    tabSizeCompartment.of([
                        EditorState.tabSize.of(
                            useSettingsStore.getState().tabSize,
                        ),
                        indentUnit.of(
                            " ".repeat(useSettingsStore.getState().tabSize),
                        ),
                    ]),
                    livePreviewCompartment.of(
                        getLivePreviewExtension(
                            useEditorStore.getState().editorMode,
                        ),
                    ),
                    search({ top: true }),
                    searchTheme,
                    keymap.of([
                        {
                            key: "Mod-f",
                            run: (view) => {
                                if (searchPanelOpen(view.state)) {
                                    closeSearchPanel(view);
                                    return true;
                                }
                                return openSearchPanel(view);
                            },
                        },
                        {
                            key: "Tab",
                            run: insertConfiguredTab,
                            shift: removeConfiguredTab,
                        },
                        ...defaultKeymap,
                        ...historyKeymap,
                        ...searchKeymap,
                    ]),
                    wikilinkExtension(resolveWikilink, navigateWikilink),
                    urlLinksExtension,
                    EditorView.updateListener.of((update) => {
                        if (!update.docChanged || isInternalRef.current) return;
                        const tab = activeTabRef.current;
                        if (!tab) return;
                        const content = update.state.doc.toString();
                        // Mark dirty immediately (cheap — no-ops if already dirty)
                        markTabDirty(tab.id);
                        // Debounce content propagation to Zustand to avoid
                        // expensive re-renders in LinksPanel on every keystroke
                        if (contentUpdateTimerRef.current)
                            clearTimeout(contentUpdateTimerRef.current);
                        contentUpdateTimerRef.current = setTimeout(() => {
                            updateTabContent(tab.id, content);
                        }, 300);
                        scheduleSave(tab, content);
                    }),
                ],
            });
        },
        [scheduleSave, markTabDirty, updateTabContent],
    );

    const replaceEditorView = useCallback((state: EditorState) => {
        const parent = containerRef.current;
        if (!parent) return null;

        const previousView = viewRef.current;
        const shouldRestoreFocus = previousView?.hasFocus ?? false;

        previousView?.destroy();

        const nextView = new EditorView({
            state,
            parent,
        });
        viewRef.current = nextView;

        if (!scrollHeaderRef.current) {
            const header = document.createElement("div");
            header.className = "cm-lp-scroll-header";
            nextView.scrollDOM.insertBefore(header, nextView.contentDOM);
            scrollHeaderRef.current = header;
        } else if (!nextView.scrollDOM.contains(scrollHeaderRef.current)) {
            nextView.scrollDOM.insertBefore(
                scrollHeaderRef.current,
                nextView.contentDOM,
            );
        }

        if (shouldRestoreFocus) {
            nextView.focus();
        }

        return nextView;
    }, []);

    // Initialize CodeMirror once — container is always in the DOM
    useEffect(() => {
        if (!containerRef.current) return;

        const initialTab = activeTabRef.current;
        const rawContent = initialTab?.content ?? "";
        const body = initialTab
            ? stripFrontmatter(initialTab.id, rawContent)
            : rawContent;

        replaceEditorView(createEditorState(body));

        setActiveFrontmatter(
            initialTab
                ? (frontmatterByTabId.current.get(initialTab.id) ?? null)
                : null,
        );
        setEditableTitle(
            initialTab
                ? deriveDisplayedTitle(
                      frontmatterByTabId.current.get(initialTab.id) ?? null,
                      body,
                      initialTab.title,
                  )
                : "",
        );
        prevTabIdRef.current = initialTab?.id ?? null;

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            if (contentUpdateTimerRef.current)
                clearTimeout(contentUpdateTimerRef.current);
            scrollHeaderRef.current?.remove();
            scrollHeaderRef.current = null;
            viewRef.current?.destroy();
            viewRef.current = null;
        };
        // stable deps — createEditorState, replaceEditorView and stripFrontmatter only depend on stable refs
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Switch tabs: save previous state, restore or create new state
    useEffect(() => {
        const currentView = viewRef.current;
        if (!currentView) return;

        const prevId = prevTabIdRef.current;
        if (prevId === activeTabId) return;
        prevTabIdRef.current = activeTabId;

        // Cancel any pending autosave (prevents saving to wrong tab)
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        // Flush pending content update so the tab's content is up-to-date
        if (contentUpdateTimerRef.current) {
            clearTimeout(contentUpdateTimerRef.current);
            contentUpdateTimerRef.current = null;
        }

        // Save previous tab's EditorState (preserves undo history + scroll)
        if (prevId && prevId !== activeTabId) {
            tabStatesRef.current.set(prevId, currentView.state);
        }

        if (!activeTabId || !activeTab) return;

        // Restore saved state or create fresh one
        const savedState = tabStatesRef.current.get(activeTabId);
        const nextState =
            savedState ??
            createEditorState(stripFrontmatter(activeTabId, activeTab.content));
        isInternalRef.current = true;
        const nextView = replaceEditorView(nextState);
        isInternalRef.current = false;
        if (!nextView) return;

        // Update frontmatter panel for this tab
        setActiveFrontmatter(
            frontmatterByTabId.current.get(activeTabId) ?? null,
        );
        setEditableTitle(
            deriveDisplayedTitle(
                frontmatterByTabId.current.get(activeTabId) ?? null,
                nextState.doc.toString(),
                activeTab.title,
            ),
        );

        // Ensure syntax theme and live preview match current settings
        nextView.dispatch({
            effects: [
                syntaxCompartment.reconfigure(
                    getSyntaxExtension(useThemeStore.getState().isDark),
                ),
                livePreviewCompartment.reconfigure(
                    getLivePreviewExtension(
                        useEditorStore.getState().editorMode,
                    ),
                ),
            ],
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabId]);

    // Reconfigure syntax theme when isDark changes
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: syntaxCompartment.reconfigure(getSyntaxExtension(isDark)),
        });
    }, [isDark]);

    // Reconfigure live preview when editorMode changes
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: livePreviewCompartment.reconfigure(
                getLivePreviewExtension(editorMode),
            ),
        });
    }, [editorMode]);

    useEffect(() => {
        if (autoSave) return;
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
    }, [autoSave]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: [
                alignmentCompartment.reconfigure(
                    getAlignmentExtension(justifyText),
                ),
                tabSizeCompartment.reconfigure([
                    EditorState.tabSize.of(tabSize),
                    indentUnit.of(" ".repeat(tabSize)),
                ]),
            ],
        });
    }, [justifyText, tabSize]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view || !activeTab || !pendingReveal) return;
        if (pendingReveal.noteId !== activeTab.noteId) return;

        const match = findWikilinks(view.state.doc.toString()).find((link) =>
            matchesRevealTarget(link.target, pendingReveal.targets),
        );

        if (!match) {
            clearPendingReveal();
            return;
        }

        const selection =
            pendingReveal.mode === "mention"
                ? (() => {
                      const line = view.state.doc.lineAt(match.from);
                      return { anchor: line.from, head: line.to };
                  })()
                : { anchor: match.from, head: match.to };

        view.dispatch({
            selection,
            scrollIntoView: true,
        });
        view.focus();
        clearPendingReveal();
    }, [activeTab, pendingReveal, clearPendingReveal]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view || !activeTab || !pendingSelectionReveal) return;
        if (pendingSelectionReveal.noteId !== activeTab.noteId) return;

        view.dispatch({
            selection: {
                anchor: pendingSelectionReveal.anchor,
                head: pendingSelectionReveal.head,
            },
            scrollIntoView: true,
        });
        view.focus();
        clearPendingSelectionReveal();
    }, [activeTab, pendingSelectionReveal, clearPendingSelectionReveal]);

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const { tabs, activeTabId, closeTab, switchTab } =
                useEditorStore.getState();

            // Cmd+W / Ctrl+W: close active tab
            if ((e.metaKey || e.ctrlKey) && e.key === "w") {
                e.preventDefault();
                if (activeTabId) {
                    const tab = tabs.find((t) => t.id === activeTabId);
                    if (tab?.isDirty) {
                        const content =
                            viewRef.current?.state.doc.toString() ??
                            tab.content;
                        saveNow(tab, content);
                    }
                    // Clean up saved EditorState
                    tabStatesRef.current.delete(activeTabId);
                    if (getWindowMode() === "note" && tabs.length === 1) {
                        void appWindow.close().catch((error) => {
                            console.error(
                                "No se pudo cerrar la ventana de nota:",
                                error,
                            );
                        });
                        return;
                    }
                    closeTab(activeTabId);
                }
            }

            // Cmd+Shift+S / Ctrl+Shift+S: save active tab immediately
            if ((e.metaKey || e.ctrlKey) && e.key === "s" && e.shiftKey) {
                const tab = tabs.find((item) => item.id === activeTabId);
                if (!tab) return;
                e.preventDefault();
                const content =
                    viewRef.current?.state.doc.toString() ?? tab.content;
                void saveNow(tab, content);
                return;
            }

            // Cmd+Plus / Cmd+Minus: adjust editor font size
            if ((e.metaKey || e.ctrlKey) && !e.altKey) {
                const { editorFontSize, setSetting } =
                    useSettingsStore.getState();

                if (e.key === "+" || e.key === "=") {
                    e.preventDefault();
                    setSetting(
                        "editorFontSize",
                        Math.min(24, editorFontSize + 1),
                    );
                    return;
                }

                if (e.key === "-" || e.key === "_") {
                    e.preventDefault();
                    setSetting(
                        "editorFontSize",
                        Math.max(10, editorFontSize - 1),
                    );
                    return;
                }
            }

            // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
            if (e.ctrlKey && e.key === "Tab") {
                e.preventDefault();
                const idx = tabs.findIndex((t) => t.id === activeTabId);
                if (idx !== -1 && tabs.length > 1) {
                    const offset = e.shiftKey ? tabs.length - 1 : 1;
                    const next = tabs[(idx + offset) % tabs.length];
                    switchTab(next.id);
                }
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [saveNow]);

    const editorShellStyle = {
        "--editor-font-size": `${editorFontSize}px`,
        "--editor-font-family": getEditorFontFamily(editorFontFamily),
        "--editor-content-width": `${editorContentWidth}px`,
    } as CSSProperties;

    const activeLocation = activeTabInfo
        ? getNoteLocation(activeTabInfo.noteId)
        : { parent: "" };

    // Always render the container so CodeMirror initializes properly
    return (
        <div
            className="editor-shell h-full overflow-hidden flex flex-col"
            style={editorShellStyle}
        >
            <div className="min-h-0 flex-1 relative">
                <div ref={containerRef} className="h-full relative z-[1]" />
                {!activeTabInfo && (
                    <div
                        className="absolute inset-0 z-[2] flex items-center justify-center"
                        style={{ background: "transparent" }}
                    >
                        <div
                            style={{
                                width: "min(480px, calc(100% - 48px))",
                                padding: "28px 28px 24px",
                                borderRadius: 20,
                                border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                                background:
                                    "color-mix(in srgb, var(--bg-primary) 90%, transparent)",
                                boxShadow: "var(--shadow-soft)",
                                textAlign: "left",
                            }}
                        >
                            <div
                                style={{
                                    width: 44,
                                    height: 44,
                                    borderRadius: 14,
                                    marginBottom: 18,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    color: "var(--accent)",
                                    background:
                                        "color-mix(in srgb, var(--accent) 12%, var(--bg-secondary))",
                                    border: "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))",
                                }}
                            >
                                <svg
                                    width="20"
                                    height="20"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.7"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M14 3H6a2 2 0 0 0-2 2v14l4-2 4 2 4-2 4 2V9z" />
                                    <path d="M14 3v6h6" />
                                </svg>
                            </div>
                            <div
                                style={{
                                    fontSize: 24,
                                    fontWeight: 700,
                                    color: "var(--text-primary)",
                                    marginBottom: 8,
                                    letterSpacing: "-0.02em",
                                }}
                            >
                                Your writing space is ready
                            </div>
                            <div
                                style={{
                                    fontSize: 14,
                                    lineHeight: 1.6,
                                    color: "var(--text-secondary)",
                                }}
                            >
                                {emptyStateMessage}. Or create a new note from
                                the top bar to get started.
                            </div>
                        </div>
                    </div>
                )}
            </div>
            {scrollHeaderRef.current &&
                activeTabInfo &&
                createPortal(
                    <div
                        style={{
                            maxWidth: "var(--editor-content-width)",
                            margin: "0 auto",
                            padding: "40px clamp(24px, 5vw, 56px) 20px",
                            boxSizing: "border-box",
                        }}
                    >
                        {activeLocation.parent && (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    flexWrap: "wrap",
                                    marginBottom: 14,
                                }}
                            >
                                <MetaBadge label={activeLocation.parent} />
                            </div>
                        )}
                        <EditableNoteTitle
                            value={editableTitle}
                            onChange={applyTitleChange}
                        />
                        <div style={{ marginTop: 20 }}>
                            <FrontmatterPanel
                                raw={activeFrontmatter ?? ""}
                                onChange={applyFrontmatterChange}
                            />
                        </div>
                    </div>,
                    scrollHeaderRef.current,
                )}
        </div>
    );
}
