import {
    useEffect,
    useRef,
    useCallback,
    useState,
    useLayoutEffect,
    type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
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
    redo,
    undo,
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
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/react/shallow";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { getWindowMode } from "../../app/detachedWindows";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
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
    activateWikilinkSuggesterAnnotation,
    markdownAutopairExtension,
} from "./extensions/markdownAutopair";
import {
    getWikilinkContext,
    getWikilinkSuggestions,
    type WikilinkSuggestionItem,
} from "./extensions/wikilinkSuggester";
import {
    FloatingSelectionToolbar,
    type FloatingSelectionToolbarState,
} from "./FloatingSelectionToolbar";
import {
    FrontmatterPanel,
    parseFrontmatterRaw,
    serializeFrontmatterRaw,
    type FrontmatterEntry,
} from "./FrontmatterPanel";
import {
    getSelectionTransform,
    type SelectionToolbarAction,
} from "./selectionTransforms";
import {
    WikilinkSuggester,
    type WikilinkSuggesterState,
} from "./WikilinkSuggester";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;
const appWindow = getCurrentWindow();

type VaultNote = ReturnType<typeof useVaultStore.getState>["notes"][number];
type SavedNoteDetail = {
    id: string;
    path: string;
    title: string;
    content: string;
};
type TabScrollPosition = {
    top: number;
    left: number;
};
type LinkContextMenuState = {
    x: number;
    y: number;
    href: string;
    noteTarget: string | null;
};
type EditorContextMenuPayload = {
    hasSelection: boolean;
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

function clearEditorDomSelection(view: EditorView | null) {
    if (!view) return;

    const selection = view.dom.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    if (selection.isCollapsed) return;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const touchesEditor =
        (!!anchorNode && view.dom.contains(anchorNode)) ||
        (!!focusNode && view.dom.contains(focusNode));

    if (touchesEditor) {
        selection.removeAllRanges();
    }
}

function syncSelectionLayerVisibility(view: EditorView | null) {
    if (!view) return;

    const layer = view.dom.querySelector(".cm-selectionLayer");
    if (!(layer instanceof HTMLElement)) return;

    const hasSelection = view.hasFocus
        ? view.state.selection.ranges.some((range) => !range.empty)
        : false;

    layer.style.opacity = hasSelection ? "1" : "0";
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
                    .openNote(note.id, note.title, detail.content, {
                        placement: "afterActive",
                    });
            })
            .catch((e) => console.error("Error reading linked note:", e));
    } else {
        // Broken link: create the note
        const { createNote } = useVaultStore.getState();
        void createNote(target).then((created) => {
            if (created) {
                useEditorStore
                    .getState()
                    .openNote(created.id, created.title, "", {
                        placement: "afterActive",
                    });
            }
        });
    }
}

function openWikilinkInNewTab(target: string) {
    const note = findNoteByWikilink(target);
    if (!note) return;

    const { tabs, insertExternalTab } = useEditorStore.getState();
    const existing = tabs.find((tab) => tab.noteId === note.id);

    if (existing) {
        insertExternalTab({
            id: crypto.randomUUID(),
            noteId: note.id,
            title: note.title,
            content: existing.content,
            isDirty: false,
        });
        return;
    }

    void invoke<{ content: string }>("read_note", { noteId: note.id })
        .then((detail) => {
            useEditorStore.getState().insertExternalTab({
                id: crypto.randomUUID(),
                noteId: note.id,
                title: note.title,
                content: detail.content,
                isDirty: false,
            });
        })
        .catch((error) =>
            console.error("Error opening linked note in new tab:", error),
        );
}

function resolveRelativeNotePath(baseNoteId: string | null, href: string): string {
    const cleanedHref = href.replace(/\\/g, "/");
    const segments = cleanedHref.startsWith("/")
        ? []
        : (baseNoteId?.split("/").slice(0, -1) ?? []);

    for (const segment of cleanedHref.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
            if (segments.length > 0) segments.pop();
            continue;
        }
        segments.push(segment);
    }

    return segments.join("/");
}

function getNoteLinkTarget(href: string): string | null {
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
    if (trimmed.startsWith("//")) return null;

    let decoded = trimmed;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        decoded = trimmed;
    }

    const normalizedTarget = decoded
        .split(/[?#]/, 1)[0]
        .trim();

    if (!normalizedTarget) return null;

    const activeTabId = useEditorStore.getState().activeTabId;
    const activeNoteId =
        useEditorStore
            .getState()
            .tabs.find((tab) => tab.id === activeTabId)?.noteId ?? null;

    const resolvedPath = resolveRelativeNotePath(activeNoteId, normalizedTarget);
    if (resolvedPath && findNoteByWikilink(resolvedPath)) {
        return resolvedPath;
    }

    const directTarget = normalizedTarget.replace(/^\/+/, "");
    if (directTarget && findNoteByWikilink(directTarget)) {
        return directTarget;
    }

    return resolvedPath || directTarget || normalizedTarget;
}

function LinkContextMenu({
    menu,
    onClose,
}: {
    menu: LinkContextMenuState;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(menu.x, menu.y, rect.width, rect.height),
        );
    }, [menu.x, menu.y]);

    useEffect(() => {
        const handleDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        const handleScroll = () => onClose();

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("scroll", handleScroll, true);

        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("scroll", handleScroll, true);
        };
    }, [onClose]);

    const linkedNote = menu.noteTarget
        ? findNoteByWikilink(menu.noteTarget)
        : null;

    const menuItem = (label: string, action: () => void) => (
        <button
            key={label}
            type="button"
            onClick={() => {
                action();
                onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-xs rounded"
            style={{
                color: "var(--text-primary)",
                background: "transparent",
            }}
            onMouseEnter={(event) => {
                event.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
            }}
            onMouseLeave={(event) => {
                event.currentTarget.style.backgroundColor = "transparent";
            }}
        >
            {label}
        </button>
    );

    return (
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10000,
                minWidth: 180,
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
        >
            {menu.noteTarget
                ? menuItem("Open note", () => {
                      navigateWikilink(menu.noteTarget ?? menu.href);
                  })
                : menuItem("Open link", () => {
                      void openUrl(menu.href);
                  })}
            {linkedNote &&
                menuItem("Open in new tab", () => {
                    openWikilinkInNewTab(linkedNote.id);
                })}
            {menuItem("Copy link", () => {
                void navigator.clipboard.writeText(menu.href);
            })}
        </div>
    );
}

const EDITOR_INTERACTIVE_PREVIEW_SELECTOR = [
    ".cm-lp-link",
    ".cm-inline-image-link",
    ".cm-youtube-link",
    ".cm-note-embed",
    ".cm-lp-footnote-ref",
    ".cm-lp-table-link",
    ".cm-lp-table-url",
].join(", ");

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
        scrollbarColor: "var(--app-scrollbar-thumb) transparent",
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
        lineHeight: "var(--text-input-line-height)",
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
    },
    ".cm-selectionBackground": {
        backgroundColor:
            "color-mix(in srgb, var(--accent) 22%, transparent) !important",
    },
    ".cm-line::selection, .cm-line > span::selection, .cm-content ::selection":
        {
            backgroundColor: "transparent",
        },
    ".cm-line::-moz-selection, .cm-line > span::-moz-selection, .cm-content ::-moz-selection":
        {
            backgroundColor: "transparent",
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
const MARKDOWN_LIST_ITEM_RE =
    /^([ \t]*)(?:(\d+)([.)])|([-+*]))[ \t]+(?:\[( |x|X)\][ \t]+)?(.*)$/;

type MarkdownListItem = {
    indent: string;
    marker: string;
    orderedNumber: number | null;
    orderedDelimiter: ")" | "." | null;
    isTask: boolean;
    content: string;
    prefixLength: number;
    isEmpty: boolean;
};

function parseMarkdownListItem(lineText: string): MarkdownListItem | null {
    const match = lineText.match(MARKDOWN_LIST_ITEM_RE);
    if (!match) return null;

    const [
        fullMatch,
        indent,
        orderedDigits,
        orderedDelimiterRaw,
        bulletMarker,
        taskMarker,
        content,
    ] = match;
    const orderedDelimiter =
        orderedDelimiterRaw === "." || orderedDelimiterRaw === ")"
            ? orderedDelimiterRaw
            : null;
    const orderedNumber = orderedDigits ? Number.parseInt(orderedDigits, 10) : null;
    const marker = orderedDigits
        ? `${orderedDigits}${orderedDelimiter ?? "."}`
        : (bulletMarker ?? "-");

    return {
        indent,
        marker,
        orderedNumber,
        orderedDelimiter,
        isTask: taskMarker !== undefined,
        content,
        prefixLength: fullMatch.length - content.length,
        isEmpty: content.trim().length === 0,
    };
}

function buildContinuedListPrefix(item: MarkdownListItem): string {
    const orderedMarker =
        item.orderedNumber !== null
            ? `${item.orderedNumber + 1}${item.orderedDelimiter ?? "."}`
            : item.marker;
    const taskSuffix = item.isTask ? "[ ] " : "";
    return `${item.indent}${orderedMarker} ${taskSuffix}`;
}

function continueMarkdownListItem({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;
    if (state.selection.ranges.length !== 1) return false;

    const range = state.selection.main;
    if (!range.empty) return false;

    const line = state.doc.lineAt(range.from);
    const item = parseMarkdownListItem(line.text);
    if (!item) return false;

    if (item.isEmpty) {
        dispatch(
            state.update({
                changes: { from: line.from, to: line.to, insert: "" },
                selection: EditorSelection.cursor(line.from),
                scrollIntoView: true,
                userEvent: "input",
            }),
        );
        return true;
    }

    const insert = `\n${buildContinuedListPrefix(item)}`;
    const anchor = range.from + insert.length;

    dispatch(
        state.update({
            changes: { from: range.from, to: range.to, insert },
            selection: EditorSelection.cursor(anchor),
            scrollIntoView: true,
            userEvent: "input",
        }),
    );

    return true;
}

function backspaceMarkdownListMarker({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;
    if (state.selection.ranges.length !== 1) return false;

    const range = state.selection.main;
    if (!range.empty) return false;

    const line = state.doc.lineAt(range.from);
    const item = parseMarkdownListItem(line.text);
    if (!item?.isEmpty) return false;

    const prefixEnd = line.from + item.prefixLength;
    if (range.from < line.from || range.from > prefixEnd) return false;

    const unit = state.facet(indentUnit);
    const deleteIndentLength = getOutdentDeleteLength(item.indent, unit.length);

    if (deleteIndentLength > 0) {
        dispatch(
            state.update({
                changes: {
                    from: line.from,
                    to: line.from + deleteIndentLength,
                },
                selection: EditorSelection.cursor(
                    Math.max(line.from, range.from - deleteIndentLength),
                ),
                scrollIntoView: true,
                userEvent: "delete.backward",
            }),
        );
        return true;
    }

    dispatch(
        state.update({
            changes: { from: line.from, to: line.to, insert: "" },
            selection: EditorSelection.cursor(line.from),
            scrollIntoView: true,
            userEvent: "delete.backward",
        }),
    );

    return true;
}

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

function getLivePreviewExtension(
    mode: EditorMode,
    openLinkContextMenu: (menu: LinkContextMenuState | null) => void,
) {
    const vaultPath = useVaultStore.getState().vaultPath;
    return mode === "preview"
        ? livePreviewExtension(vaultPath, {
              resolveWikilink,
              navigateWikilink,
              getNoteLinkTarget,
              openLinkContextMenu,
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
    textareaRef,
    onContextMenu,
}: {
    value: string;
    onChange: (nextValue: string) => void;
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
    onContextMenu?: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
}) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        if (textareaRef) {
            textareaRef.current = ref.current;
        }
    }, [textareaRef]);

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
            onContextMenu={onContextMenu}
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
    const restoreScrollFrameRef = useRef<number | null>(null);
    const selectionToolbarCleanupRef = useRef<(() => void) | null>(null);
    const activeTabRef = useRef<Tab | null>(null);
    const wikilinkSuggesterArmedRef = useRef(false);
    const wikilinkSuggesterRef = useRef<WikilinkSuggesterState | null>(null);
    const isInternalRef = useRef(false);
    // Save/restore full EditorState per tab (preserves undo history + selection)
    const tabStatesRef = useRef<Map<string, EditorState>>(new Map());
    const tabScrollPositionsRef = useRef<Map<string, TabScrollPosition>>(
        new Map(),
    );
    const prevTabIdRef = useRef<string | null>(null);
    // Frontmatter: stores the raw ---...--- block per tab so we can restore it on save
    const frontmatterByTabId = useRef<Map<string, string>>(new Map());
    const [activeFrontmatter, setActiveFrontmatter] = useState<string | null>(
        null,
    );
    const [editableTitle, setEditableTitle] = useState("");
    const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
    const [linkContextMenu, setLinkContextMenu] =
        useState<LinkContextMenuState | null>(null);
    const [editorContextMenu, setEditorContextMenu] =
        useState<ContextMenuState<EditorContextMenuPayload> | null>(null);
    const [titleContextMenu, setTitleContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const [selectionToolbar, setSelectionToolbar] =
        useState<FloatingSelectionToolbarState | null>(null);
    const [wikilinkSuggester, setWikilinkSuggester] =
        useState<WikilinkSuggesterState | null>(null);
    const scrollHeaderRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        wikilinkSuggesterRef.current = wikilinkSuggester;
    }, [wikilinkSuggester]);

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
    const editorLineHeight = useSettingsStore((s) => s.editorLineHeight);
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const justifyText = useSettingsStore((s) => s.justifyText);
    const tabSize = useSettingsStore((s) => s.tabSize);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);
    const touchVault = useVaultStore((s) => s.touchVault);

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

    const saveTabScrollPosition = useCallback(
        (tabId: string, view: EditorView | null) => {
            if (!view) return;
            tabScrollPositionsRef.current.set(tabId, {
                top: view.scrollDOM.scrollTop,
                left: view.scrollDOM.scrollLeft,
            });
        },
        [],
    );

    const restoreTabScrollPosition = useCallback(
        (tabId: string, view: EditorView | null) => {
            if (!view) return;

            const position = tabScrollPositionsRef.current.get(tabId);
            if (restoreScrollFrameRef.current !== null) {
                cancelAnimationFrame(restoreScrollFrameRef.current);
                restoreScrollFrameRef.current = null;
            }

            restoreScrollFrameRef.current = requestAnimationFrame(() => {
                if (viewRef.current !== view) return;

                view.scrollDOM.scrollTop = position?.top ?? 0;
                view.scrollDOM.scrollLeft = position?.left ?? 0;
                restoreScrollFrameRef.current = null;
            });
        },
        [],
    );

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
                touchVault();
            } catch (e) {
                console.error("Error al guardar nota:", e);
            }
        },
        [
            markTabClean,
            stripFrontmatter,
            touchVault,
            updateNoteMetadata,
            updateTabTitle,
        ],
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

    const copySelectedText = useCallback(async () => {
        const view = viewRef.current;
        if (!view) return;
        const selection = view.state.selection.main;
        if (selection.empty) return;

        try {
            await navigator.clipboard.writeText(
                view.state.sliceDoc(selection.from, selection.to),
            );
        } catch (error) {
            console.error("Error copying editor selection:", error);
        }
    }, []);

    const cutSelectedText = useCallback(async () => {
        const view = viewRef.current;
        if (!view) return;
        const selection = view.state.selection.main;
        if (selection.empty) return;

        try {
            await navigator.clipboard.writeText(
                view.state.sliceDoc(selection.from, selection.to),
            );
            view.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: "",
                },
                selection: { anchor: selection.from },
                userEvent: "delete.cut",
            });
            view.focus();
        } catch (error) {
            console.error("Error cutting editor selection:", error);
        }
    }, []);

    const pasteClipboardText = useCallback(async () => {
        const view = viewRef.current;
        if (!view) return;

        try {
            const text = await navigator.clipboard.readText();
            if (text.length === 0) return;

            const selection = view.state.selection.main;
            view.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: text,
                },
                selection: { anchor: selection.from + text.length },
                userEvent: "input.paste",
            });
            view.focus();
        } catch (error) {
            console.error("Error pasting into editor:", error);
        }
    }, []);

    const selectAllEditorText = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
            selection: EditorSelection.single(0, view.state.doc.length),
        });
        view.focus();
    }, []);

    const handleOpenLinkContextMenu = useCallback(
        (menu: LinkContextMenuState | null) => {
            setSelectionToolbar(null);
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
            setEditorContextMenu(null);
            setLinkContextMenu(menu);
        },
        [],
    );

    const updateSelectionToolbar = useCallback((view: EditorView | null) => {
        if (!view || !activeTabRef.current || !view.hasFocus) {
            clearEditorDomSelection(view);
            syncSelectionLayerVisibility(view);
            setSelectionToolbar(null);
            return;
        }

        if (view.state.selection.ranges.length !== 1) {
            clearEditorDomSelection(view);
            syncSelectionLayerVisibility(view);
            setSelectionToolbar(null);
            return;
        }

        const selection = view.state.selection.main;
        if (selection.empty) {
            clearEditorDomSelection(view);
            syncSelectionLayerVisibility(view);
            setSelectionToolbar(null);
            return;
        }

        const selectionStart = view.coordsAtPos(selection.from, 1);
        const selectionEnd = view.coordsAtPos(
            Math.max(selection.from, selection.to - 1),
            -1,
        );
        if (!selectionStart || !selectionEnd) {
            clearEditorDomSelection(view);
            syncSelectionLayerVisibility(view);
            setSelectionToolbar(null);
            return;
        }

        syncSelectionLayerVisibility(view);
        const startLine = view.state.doc.lineAt(selection.from).number;
        const endLine = view.state.doc.lineAt(
            Math.max(selection.from, selection.to - 1),
        ).number;
        const sameLine = startLine === endLine;

        setSelectionToolbar({
            x: sameLine
                ? (selectionStart.left + selectionEnd.right) / 2
                : (selectionStart.left + selectionStart.right) / 2,
            top: selectionStart.top,
            bottom: Math.max(selectionStart.bottom, selectionEnd.bottom),
            selectionFrom: selection.from,
            selectionTo: selection.to,
        });
    }, []);

    const handleSelectionToolbarAction = useCallback(
        (action: SelectionToolbarAction) => {
            const view = viewRef.current;
            if (!view) return;

            const transform = getSelectionTransform(view.state, action);
            if (!transform) return;

            view.dispatch({
                changes: transform.changes,
                selection: transform.selection,
                scrollIntoView: true,
                userEvent: transform.userEvent,
            });
            view.focus();
            updateSelectionToolbar(view);
        },
        [updateSelectionToolbar],
    );

    const updateWikilinkSuggester = useCallback((view: EditorView | null) => {
        if (!view || !activeTabRef.current || !view.hasFocus) {
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
            return;
        }

        const context = getWikilinkContext(view.state);
        if (!context) {
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
            return;
        }

        if (!wikilinkSuggesterArmedRef.current) {
            setWikilinkSuggester(null);
            return;
        }

        const caret = view.coordsAtPos(view.state.selection.main.head);
        if (!caret) {
            setWikilinkSuggester(null);
            return;
        }

        const items = getWikilinkSuggestions(
            useVaultStore.getState().notes,
            context.query,
        );

        setWikilinkSuggester((previous) => ({
            x: caret.left,
            y: caret.top,
            query: context.query,
            selectedIndex: previous
                ? Math.min(previous.selectedIndex, Math.max(items.length - 1, 0))
                : 0,
            items,
            wholeFrom: context.wholeFrom,
            wholeTo: context.wholeTo,
        }));
    }, []);

    const moveWikilinkSuggesterSelection = useCallback((direction: 1 | -1) => {
        const suggester = wikilinkSuggesterRef.current;
        if (!suggester || !suggester.items.length) return false;

        setWikilinkSuggester((previous) => {
            if (!previous || !previous.items.length) return previous;
            const itemCount = previous.items.length;
            return {
                ...previous,
                selectedIndex:
                    (previous.selectedIndex + direction + itemCount) % itemCount,
            };
        });
        return true;
    }, []);

    const commitWikilinkSuggestion = useCallback(
        (item?: WikilinkSuggestionItem) => {
            const view = viewRef.current;
            const suggester = wikilinkSuggesterRef.current;
            if (!view || !suggester) return false;

            const nextItem = item ?? suggester.items[suggester.selectedIndex];
            if (!nextItem) return false;

            const insert = `[[${nextItem.insertText}]]`;
            view.dispatch({
                changes: {
                    from: suggester.wholeFrom,
                    to: suggester.wholeTo,
                    insert,
                },
                selection: EditorSelection.cursor(
                    suggester.wholeFrom + insert.length,
                ),
                scrollIntoView: true,
                userEvent: "input",
            });
            view.focus();
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
            return true;
        },
        [],
    );

    const closeWikilinkSuggester = useCallback(() => {
        if (!wikilinkSuggesterRef.current) return false;
        wikilinkSuggesterArmedRef.current = false;
        setWikilinkSuggester(null);
        return true;
    }, []);

    const handleEditorContextMenu = useCallback(
        (event: { clientX: number; clientY: number; target: EventTarget | null; preventDefault: () => void }) => {
            if (!activeTabRef.current) return false;
            const view = viewRef.current;
            if (!view) return false;

            const rawTarget = event.target;
            const target =
                rawTarget instanceof Element
                    ? rawTarget
                    : rawTarget instanceof Node
                      ? rawTarget.parentElement
                      : null;

            const liveLink = target?.closest(".cm-lp-link") as HTMLElement | null;
            if (liveLink?.dataset.href) {
                event.preventDefault();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: liveLink.dataset.href,
                    noteTarget: getNoteLinkTarget(liveLink.dataset.href),
                });
                return true;
            }

            const wikilink = target?.closest(".cm-wikilink") as HTMLElement | null;
            if (wikilink?.dataset.wikilinkTarget) {
                event.preventDefault();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: wikilink.dataset.wikilinkTarget,
                    noteTarget: wikilink.dataset.wikilinkTarget,
                });
                return true;
            }

            const linkedImage = target?.closest(
                ".cm-inline-image-link",
            ) as HTMLElement | null;
            if (linkedImage?.dataset.href) {
                event.preventDefault();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: linkedImage.dataset.href,
                    noteTarget: null,
                });
                return true;
            }

            const tableUrl = target?.closest(".cm-lp-table-url") as HTMLElement | null;
            if (tableUrl?.dataset.url) {
                event.preventDefault();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: tableUrl.dataset.url,
                    noteTarget: null,
                });
                return true;
            }

            if (target?.closest(EDITOR_INTERACTIVE_PREVIEW_SELECTOR)) {
                return false;
            }

            const pos = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            const selection = view.state.selection.main;

            if (
                pos !== null &&
                (selection.empty || pos < selection.from || pos > selection.to)
            ) {
                view.dispatch({
                    selection: { anchor: pos },
                });
            }

            event.preventDefault();
            setSelectionToolbar(null);
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
            setLinkContextMenu(null);
            setTitleContextMenu(null);
            setEditorContextMenu({
                x: event.clientX,
                y: event.clientY,
                    payload: {
                        hasSelection: !view.state.selection.main.empty,
                    },
                });
            return true;
        },
        [],
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
                    drawSelection(),
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
                            handleOpenLinkContextMenu,
                        ),
                    ),
                    search({ top: true }),
                    searchTheme,
                    markdownAutopairExtension,
                    keymap.of([
                        {
                            key: "ArrowDown",
                            run: () => moveWikilinkSuggesterSelection(1),
                        },
                        {
                            key: "ArrowUp",
                            run: () => moveWikilinkSuggesterSelection(-1),
                        },
                        {
                            key: "Enter",
                            run: () => commitWikilinkSuggestion(),
                        },
                        {
                            key: "Escape",
                            run: () => closeWikilinkSuggester(),
                        },
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
                            key: "Enter",
                            run: continueMarkdownListItem,
                        },
                        {
                            key: "Backspace",
                            run: backspaceMarkdownListMarker,
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
                    EditorView.updateListener.of((update) => {
                        if (
                            update.transactions.some((transaction) =>
                                transaction.annotation(
                                    activateWikilinkSuggesterAnnotation,
                                ),
                            )
                        ) {
                            wikilinkSuggesterArmedRef.current = true;
                        }

                        if (
                            update.docChanged ||
                            update.selectionSet ||
                            update.viewportChanged ||
                            update.focusChanged
                        ) {
                            updateSelectionToolbar(update.view);
                            updateWikilinkSuggester(update.view);
                        }
                    }),
                ],
            });
        },
        [
            closeWikilinkSuggester,
            commitWikilinkSuggestion,
            moveWikilinkSuggesterSelection,
            updateSelectionToolbar,
            updateWikilinkSuggester,
            handleOpenLinkContextMenu,
            scheduleSave,
            markTabDirty,
            updateTabContent,
        ],
    );

    const replaceEditorView = useCallback((state: EditorState) => {
        const parent = containerRef.current;
        if (!parent) return null;

        const previousView = viewRef.current;
        const shouldRestoreFocus = previousView?.hasFocus ?? false;

        selectionToolbarCleanupRef.current?.();
        selectionToolbarCleanupRef.current = null;
        clearEditorDomSelection(previousView);
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

        const handleScrollOrResize = () => {
            updateSelectionToolbar(nextView);
            updateWikilinkSuggester(nextView);
        };
        const handleNativeContextMenu = (event: MouseEvent) => {
            const handled = handleEditorContextMenu(event);
            if (!handled) return;
            event.stopPropagation();
        };

        nextView.scrollDOM.addEventListener("scroll", handleScrollOrResize, {
            passive: true,
        });
        window.addEventListener("resize", handleScrollOrResize);
        nextView.dom.addEventListener(
            "contextmenu",
            handleNativeContextMenu,
            true,
        );
        selectionToolbarCleanupRef.current = () => {
            nextView.scrollDOM.removeEventListener(
                "scroll",
                handleScrollOrResize,
            );
            window.removeEventListener("resize", handleScrollOrResize);
            nextView.dom.removeEventListener(
                "contextmenu",
                handleNativeContextMenu,
                true,
            );
        };
        updateSelectionToolbar(nextView);
        updateWikilinkSuggester(nextView);

        return nextView;
    }, [
        handleEditorContextMenu,
        updateSelectionToolbar,
        updateWikilinkSuggester,
    ]);

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
            if (restoreScrollFrameRef.current !== null) {
                cancelAnimationFrame(restoreScrollFrameRef.current);
                restoreScrollFrameRef.current = null;
            }
            selectionToolbarCleanupRef.current?.();
            selectionToolbarCleanupRef.current = null;
            scrollHeaderRef.current?.remove();
            scrollHeaderRef.current = null;
            viewRef.current?.destroy();
            viewRef.current = null;
            setSelectionToolbar(null);
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
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

        // Save previous tab's EditorState and viewport position
        if (prevId && prevId !== activeTabId) {
            tabStatesRef.current.set(prevId, currentView.state);
            saveTabScrollPosition(prevId, currentView);
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
        restoreTabScrollPosition(activeTabId, nextView);
        updateSelectionToolbar(nextView);
        updateWikilinkSuggester(nextView);

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
                        handleOpenLinkContextMenu,
                    ),
                ),
            ],
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        activeTabId,
        restoreTabScrollPosition,
        saveTabScrollPosition,
        updateSelectionToolbar,
        updateWikilinkSuggester,
    ]);

    useEffect(() => {
        if (activeTabInfo) return;
        setSelectionToolbar(null);
        wikilinkSuggesterArmedRef.current = false;
        setWikilinkSuggester(null);
    }, [activeTabInfo]);

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
                getLivePreviewExtension(editorMode, handleOpenLinkContextMenu),
            ),
        });
    }, [editorMode, handleOpenLinkContextMenu]);

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
        "--text-input-line-height": String(editorLineHeight / 100),
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
                <div
                    ref={containerRef}
                    className="h-full relative z-1"
                    onContextMenu={(event) => {
                        void handleEditorContextMenu(event);
                    }}
                />
                {!activeTabInfo && (
                    <div
                        className="absolute inset-0 z-2 flex items-center justify-center"
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
                {selectionToolbar && (
                    <FloatingSelectionToolbar
                        toolbar={selectionToolbar}
                        editorElement={viewRef.current?.dom ?? null}
                        onAction={handleSelectionToolbarAction}
                        onClose={() => setSelectionToolbar(null)}
                    />
                )}
                {wikilinkSuggester && (
                    <WikilinkSuggester
                        suggester={wikilinkSuggester}
                        editorElement={viewRef.current?.dom ?? null}
                        onHoverIndex={(index) => {
                            setWikilinkSuggester((previous) =>
                                previous
                                    ? { ...previous, selectedIndex: index }
                                    : previous,
                            );
                        }}
                        onSelect={(item) => {
                            void commitWikilinkSuggestion(item);
                        }}
                        onClose={() => {
                            void closeWikilinkSuggester();
                        }}
                    />
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
                            textareaRef={titleInputRef}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setEditorContextMenu(null);
                                setLinkContextMenu(null);
                                setTitleContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    payload: undefined,
                                });
                            }}
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
            {linkContextMenu &&
                createPortal(
                    <LinkContextMenu
                        menu={linkContextMenu}
                        onClose={() => setLinkContextMenu(null)}
                    />,
                    document.body,
                )}
            {editorContextMenu && (
                <ContextMenu
                    menu={editorContextMenu}
                    onClose={() => setEditorContextMenu(null)}
                    minWidth={138}
                    entries={[
                        {
                            label: "Undo",
                            action: () => {
                                const view = viewRef.current;
                                if (!view) return;
                                undo(view);
                                view.focus();
                            },
                        },
                        {
                            label: "Redo",
                            action: () => {
                                const view = viewRef.current;
                                if (!view) return;
                                redo(view);
                                view.focus();
                            },
                        },
                        { type: "separator" },
                        {
                            label: "Cut",
                            action: () => void cutSelectedText(),
                            disabled: !editorContextMenu.payload.hasSelection,
                        },
                        {
                            label: "Copy",
                            action: () => void copySelectedText(),
                            disabled: !editorContextMenu.payload.hasSelection,
                        },
                        {
                            label: "Paste",
                            action: () => void pasteClipboardText(),
                        },
                        { type: "separator" },
                        {
                            label: "Select All",
                            action: () => selectAllEditorText(),
                        },
                    ]}
                />
            )}
            {titleContextMenu && (
                <ContextMenu
                    menu={titleContextMenu}
                    onClose={() => setTitleContextMenu(null)}
                    entries={[
                        {
                            label: "Rename Note",
                            action: () => {
                                titleInputRef.current?.focus();
                                titleInputRef.current?.select();
                            },
                        },
                        {
                            label: "Copy Title",
                            action: () =>
                                void navigator.clipboard.writeText(editableTitle),
                        },
                    ]}
                />
            )}
        </div>
    );
}
