import {
    useEffect,
    useRef,
    useCallback,
    useState,
    type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { EditorSelection, EditorState, type Text } from "@codemirror/state";
import {
    history,
    defaultKeymap,
    historyKeymap,
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
import { indentUnit } from "@codemirror/language";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { useShallow } from "zustand/react/shallow";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { findWikilinks } from "../../app/utils/wikilinks";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useThemeStore } from "../../app/store/themeStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    getCodeMirrorShortcut,
    matchesShortcutAction,
    formatPrimaryShortcut,
} from "../../app/shortcuts/registry";
import { getDesktopPlatform } from "../../app/utils/platform";

export const REQUEST_CLOSE_ACTIVE_TAB_EVENT =
    "vaultai:editor:request-close-active-tab";
import { wikilinkExtension } from "./extensions/wikilinks";
import { urlLinksExtension } from "./extensions/urlLinks";
import { imagePasteDropExtension } from "./extensions/imagePasteDrop";
import { fileTreeDropExtension } from "./extensions/fileTreeDrop";
import {
    createMarkdownSearchPanel,
    markdownSearchMatchTheme,
    setSearchPanelContextMenuCallback,
    type SearchPanelOptions,
} from "./extensions/markdownSearchPanel";
import {
    continueMarkdownListItem,
    backspaceMarkdownListMarker,
    insertConfiguredTab,
    removeConfiguredTab,
} from "./markdownLists";
import {
    FRONTMATTER_RE,
    getNoteLocation,
    deriveDisplayedTitle,
    upsertFrontmatterTitle,
    replaceOrInsertLeadingHeading,
} from "./noteTitleHelpers";
import {
    clearEditorDomSelection,
    syncSelectionLayerVisibility,
    EDITOR_INTERACTIVE_PREVIEW_SELECTOR,
} from "./editorSelectionHelpers";
import {
    matchesRevealTarget,
    resolveWikilinksBatch,
} from "./wikilinkResolution";
import { navigateWikilink, getNoteLinkTarget } from "./wikilinkNavigation";
import { MarkdownNoteHeader } from "./MarkdownNoteHeader";
import { LinkContextMenu } from "./LinkContextMenu";
import {
    EmbedContextMenu,
    type EmbedContextMenuState,
} from "./EmbedContextMenu";
import {
    type LinkContextMenuState,
    baseTheme,
    syntaxCompartment,
    livePreviewCompartment,
    alignmentCompartment,
    wrappingCompartment,
    tabSizeCompartment,
    spellcheckCompartment,
    spellcheckDecorationsCompartment,
    grammarDecorationsCompartment,
    getSyntaxExtension,
    getLivePreviewExtension,
    getAlignmentExtension,
    getWrappingExtension,
    getSpellcheckExtension,
    getEditorFontFamily,
} from "./editorExtensions";
import { mergeViewCompartment } from "./extensions/mergeViewDiff";
import { syncMergeViewForPaths } from "./mergeViewSync";
import { resolveEditorTargetForOpenTab } from "./editorTargetResolver";
import { subscribeEditorReviewSync } from "./editorReviewSync";
import { resolveMarkdownCodeLanguage } from "./codeLanguage";
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
    getBlockquoteTransform,
    getCodeBlockLanguageAtSelection,
    getCodeBlockTransform,
    getHeadingTransform,
    getHorizontalRuleTransform,
    getSelectionTransform,
    getSetCodeBlockLanguageTransform,
    type HeadingLevel,
    type SelectionTransformResult,
    type SelectionToolbarAction,
} from "./selectionTransforms";
import {
    WikilinkSuggester,
    type WikilinkSuggesterState,
} from "./WikilinkSuggester";
import { useChatStore } from "../ai/store/chatStore";
import { aiRegisterFileBaseline } from "../ai/api";
import {
    changeAuthorAnnotation,
    userEditNotifier,
} from "./extensions/changeAuthor";
import {
    resolveFrontendSpellcheckLanguage,
    resolveFrontendSpellcheckLanguageCandidates,
    spellcheckCheckGrammar,
} from "../spellcheck/api";
import { getSpellcheckEditorExtension } from "./extensions/spellcheck";
import {
    getGrammarEditorExtension,
    findGrammarDiagnosticsAt,
} from "./extensions/grammar";
import { useSpellcheckStore } from "../spellcheck/store";
import { useCommandStore } from "../command-palette/store/commandStore";
import {
    buildSpellcheckContextMenuEntries,
    findTextInputWordRange,
    isSpellcheckCandidate,
    type SpellcheckContextMenuPayload,
    type SpellcheckGrammarContextDiagnostic,
} from "../spellcheck/contextMenu";

type SavedNoteDetail = {
    id: string;
    path: string;
    title: string;
    content: string;
};
type ReloadedNoteMetadata = {
    origin?: "user" | "agent" | "external" | "system" | "unknown";
    opId?: string | null;
    revision?: number;
    contentHash?: string | null;
};
type TabScrollPosition = {
    top: number;
    left: number;
};
interface EditorProps {
    emptyStateMessage?: string;
}

const MERGE_SYNC_FOCUS_DEBOUNCE_MS = 120;

function isRecoverableCoordinateLookupError(error: unknown) {
    return (
        error instanceof Error &&
        (error.message.includes("No tile at position") ||
            error.message.includes("Cannot destructure property 'tile'"))
    );
}

export function Editor({
    emptyStateMessage = "Open a note from the left panel",
}: EditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleSaveRef = useRef<(tabId: string, doc: Text | string) => void>(
        () => {},
    );
    const contentUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const externalReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const restoreScrollFrameRef = useRef<number | null>(null);
    const selectionToolbarCleanupRef = useRef<(() => void) | null>(null);
    const mergeSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    const activeTabRef = useRef<NoteTab | null>(null);
    const wikilinkSuggesterArmedRef = useRef(false);
    const wikilinkSuggesterRef = useRef<WikilinkSuggesterState | null>(null);
    const wikilinkSuggestionRequestIdRef = useRef(0);
    const isInternalRef = useRef(false);
    // Save/restore full EditorState per note (preserves undo history + selection)
    // Keyed by noteId so each note's state is preserved independently, even within the same tab.
    const tabStatesRef = useRef<Map<string, EditorState>>(new Map());
    const tabScrollPositionsRef = useRef<Map<string, TabScrollPosition>>(
        new Map(),
    );
    const prevTabIdRef = useRef<string | null>(null);
    const prevNoteIdRef = useRef<string | null>(null);
    const lastSavedContentByTabId = useRef<Map<string, string>>(new Map());
    const lastAckRevisionByTabId = useRef<Map<string, number>>(new Map());
    const pendingLocalOpIdByTabId = useRef<Map<string, string>>(new Map());
    // Frontmatter: stores the raw ---...--- block per note so we can restore it on save
    const frontmatterByTabId = useRef<Map<string, string>>(new Map());
    const [activeFrontmatter, setActiveFrontmatter] = useState<string | null>(
        null,
    );
    const [editableTitle, setEditableTitle] = useState("");
    const [propertiesExpanded, setPropertiesExpanded] = useState(false);
    const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
    const [linkContextMenu, setLinkContextMenu] =
        useState<LinkContextMenuState | null>(null);
    const [embedContextMenu, setEmbedContextMenu] =
        useState<EmbedContextMenuState | null>(null);
    const [editorContextMenu, setEditorContextMenu] =
        useState<ContextMenuState<SpellcheckContextMenuPayload> | null>(null);
    const [titleContextMenu, setTitleContextMenu] =
        useState<ContextMenuState<SpellcheckContextMenuPayload> | null>(null);
    const [searchContextMenu, setSearchContextMenu] = useState<{
        x: number;
        y: number;
        options: SearchPanelOptions;
        toggle: (key: keyof SearchPanelOptions) => void;
    } | null>(null);
    const [selectionToolbar, setSelectionToolbar] =
        useState<FloatingSelectionToolbarState | null>(null);
    const [wikilinkSuggester, setWikilinkSuggester] =
        useState<WikilinkSuggesterState | null>(null);
    const [isDraggingVault, setIsDraggingVault] = useState(false);
    const scrollHeaderRef = useRef<HTMLDivElement | null>(null);
    const spellcheckRequestIdRef = useRef(0);
    const didLogCoordinateLookupErrorRef = useRef(false);
    const [, setEditorView] = useState<EditorView | null>(null);

    // Bridge: search panel context menu callback
    useEffect(() => {
        setSearchPanelContextMenuCallback((x, y, options, toggle) => {
            setSearchContextMenu({ x, y, options, toggle });
        });
        return () => setSearchPanelContextMenuCallback(null);
    }, []);

    const attachScrollHeader = useCallback((view: EditorView) => {
        if (!scrollHeaderRef.current) {
            const header = document.createElement("div");
            header.className = "cm-lp-scroll-header";
            scrollHeaderRef.current = header;
        }

        const header = scrollHeaderRef.current;
        if (!header) {
            return;
        }

        const firstChild = view.scrollDOM.firstChild;
        if (firstChild !== header) {
            view.scrollDOM.insertBefore(header, firstChild);
        }

        view.requestMeasure();
    }, []);

    useEffect(() => {
        wikilinkSuggesterRef.current = wikilinkSuggester;
    }, [wikilinkSuggester]);

    // Extract and strip frontmatter from content. Stores the raw block in the ref.
    // Returns the body (content after the frontmatter block).
    const stripFrontmatter = useCallback(
        (_tabId: string, content: string): string => {
            // Source mode: frontmatter stays in the editor as raw text.
            // This keeps the editor document aligned with TrackedFile.currentText
            // so that the inline diff / merge view works correctly.
            return content;
        },
        [],
    );

    const activeTabId = useEditorStore((s) => s.activeTabId);
    const pendingReveal = useEditorStore((s) => s.pendingReveal);
    const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal);
    const pendingSelectionReveal = useEditorStore(
        (s) => s.pendingSelectionReveal,
    );
    const clearPendingSelectionReveal = useEditorStore(
        (s) => s.clearPendingSelectionReveal,
    );
    const updateTabContent = useEditorStore((s) => s.updateTabContent);
    const updateTabTitle = useEditorStore((s) => s.updateTabTitle);
    const clearNoteExternalConflict = useEditorStore(
        (s) => s.clearNoteExternalConflict,
    );
    const registerCommand = useCommandStore((s) => s.register);
    const unregisterCommand = useCommandStore((s) => s.unregister);
    const isDark = useThemeStore((s) => s.isDark);
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
    const editorLineHeight = useSettingsStore((s) => s.editorLineHeight);
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const lineWrapping = useSettingsStore((s) => s.lineWrapping);
    const justifyText = useSettingsStore((s) => s.justifyText);
    const livePreviewEnabled = useSettingsStore((s) => s.livePreviewEnabled);
    const tabSize = useSettingsStore((s) => s.tabSize);
    const editorSpellcheck = useSettingsStore((s) => s.editorSpellcheck);
    const spellcheckPrimaryLanguage = useSettingsStore(
        (s) => s.spellcheckPrimaryLanguage,
    );
    const spellcheckSecondaryLanguage = useSettingsStore(
        (s) => s.spellcheckSecondaryLanguage,
    );
    const grammarCheckEnabled = useSettingsStore((s) => s.grammarCheckEnabled);
    const grammarCheckServerUrl = useSettingsStore(
        (s) => s.grammarCheckServerUrl,
    );
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);
    const touchContent = useVaultStore((s) => s.touchContent);
    const openVault = useVaultStore((s) => s.openVault);

    // Only re-renders when the active tab identity changes, not on content updates
    const activeTabInfo = useEditorStore(
        useShallow((s) => {
            const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? null;
            if (!tab || !isNoteTab(tab)) return null;
            return {
                id: tab.id,
                title: tab.title,
                noteId: tab.noteId,
            };
        }),
    );
    const activeTab = ((): NoteTab | null => {
        if (activeTabId === null) return null;
        const t = useEditorStore
            .getState()
            .tabs.find((t) => t.id === activeTabId);
        return t && isNoteTab(t) ? t : null;
    })();
    activeTabRef.current = activeTab;
    const titleSpellcheckEnabled =
        editorSpellcheck &&
        typeof activeTabInfo?.noteId === "string" &&
        activeTabInfo.noteId.length > 0;
    const titleSpellcheckLanguage = titleSpellcheckEnabled
        ? resolveFrontendSpellcheckLanguage(spellcheckPrimaryLanguage)
        : undefined;
    const hasExternalConflict = useEditorStore((state) => {
        const noteId = activeTabInfo?.noteId;
        return noteId ? state.noteExternalConflicts.has(noteId) : false;
    });

    const runMergeViewSync = useCallback((mode?: "source" | "preview") => {
        const noteId = activeTabRef.current?.noteId;
        syncMergeViewForPaths(
            viewRef.current,
            noteId ? [`${noteId}.md`] : [],
            useChatStore.getState().sessionsById,
            {
                mode:
                    mode ??
                    (useSettingsStore.getState().livePreviewEnabled
                        ? "preview"
                        : "source"),
            },
        );
    }, []);

    const scheduleMergeViewSync = useCallback(
        ({ preferDebounce = false }: { preferDebounce?: boolean } = {}) => {
            if (mergeSyncTimerRef.current) {
                clearTimeout(mergeSyncTimerRef.current);
                mergeSyncTimerRef.current = null;
            }

            const mode = useSettingsStore.getState().livePreviewEnabled
                ? "preview"
                : "source";
            const shouldDebounce =
                preferDebounce &&
                mode === "source" &&
                Boolean(viewRef.current?.hasFocus);

            if (!shouldDebounce) {
                runMergeViewSync(mode);
                return;
            }

            mergeSyncTimerRef.current = setTimeout(() => {
                mergeSyncTimerRef.current = null;
                runMergeViewSync(mode);
            }, MERGE_SYNC_FOCUS_DEBOUNCE_MS);
        },
        [runMergeViewSync],
    );

    const getCurrentBody = useCallback(() => {
        return (
            viewRef.current?.state.doc.toString() ??
            activeTabRef.current?.content ??
            ""
        );
    }, []);

    const serializePersistedContent = useCallback(
        (_tabId: string, body: string) =>
            // Source mode: frontmatter is already in the editor body.
            body,
        [],
    );

    const markTabSaved = useCallback(
        (tabId: string, serializedContent: string) => {
            lastSavedContentByTabId.current.set(tabId, serializedContent);
        },
        [],
    );

    const isTabDirty = useCallback(
        (tabId: string, body: string) =>
            serializePersistedContent(tabId, body) !==
            lastSavedContentByTabId.current.get(tabId),
        [serializePersistedContent],
    );

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
        async (
            tab: Pick<NoteTab, "id" | "noteId" | "title" | "content">,
            content: string,
        ) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            if (!tab.noteId) return;
            const serializedContent = serializePersistedContent(
                tab.noteId,
                content,
            );
            if (
                lastSavedContentByTabId.current.get(tab.noteId) ===
                serializedContent
            ) {
                return;
            }
            const localOpId =
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `local-save-${Date.now()}-${Math.random()}`;
            pendingLocalOpIdByTabId.current.set(tab.noteId, localOpId);
            try {
                const detail = await vaultInvoke<SavedNoteDetail>("save_note", {
                    noteId: tab.noteId,
                    content: serializedContent,
                    opId: localOpId,
                });
                stripFrontmatter(tab.noteId, detail.content);
                markTabSaved(tab.noteId, detail.content);
                updateTabTitle(tab.id, detail.title);
                updateNoteMetadata(tab.noteId, {
                    title: detail.title,
                    path: detail.path,
                    modified_at: Math.floor(Date.now() / 1000),
                });
                if (activeTabRef.current?.id === tab.id) {
                    setActiveFrontmatter(
                        frontmatterByTabId.current.get(tab.noteId) ?? null,
                    );
                    setEditableTitle(detail.title);
                }
                clearNoteExternalConflict(tab.noteId);
                touchContent();
            } catch (e) {
                pendingLocalOpIdByTabId.current.delete(tab.noteId);
                console.error("Error al guardar nota:", e);
                return false;
            }
            return true;
        },
        [
            markTabSaved,
            serializePersistedContent,
            stripFrontmatter,
            touchContent,
            updateNoteMetadata,
            updateTabTitle,
            clearNoteExternalConflict,
        ],
    );

    const closeActiveTabWithSave = useCallback(() => {
        const { tabs, activeTabId, closeTab } = useEditorStore.getState();
        if (!activeTabId) return;

        const tab = tabs.find((item) => item.id === activeTabId);
        if (!tab) return;

        if (!isNoteTab(tab)) {
            closeTab(activeTabId, { reason: "user" });
            return;
        }

        const content = viewRef.current?.state.doc.toString() ?? tab.content;
        void (async () => {
            const saved = await saveNow(tab, content);
            if (saved === false) return;

            // Clean up saved EditorState for all notes in this tab's history.
            for (const entry of tab.history ?? []) {
                if (entry.kind === "note") {
                    tabStatesRef.current.delete(entry.noteId);
                }
            }
            tabStatesRef.current.delete(tab.noteId);
            closeTab(activeTabId, { reason: "user" });
        })();
    }, [saveNow]);

    const reloadNoteFromDisk = useCallback(async () => {
        const tab = activeTabRef.current;
        if (!tab) return;

        try {
            const detail = await vaultInvoke<{
                title: string;
                content: string;
            }>("read_note", {
                noteId: tab.noteId,
            });
            useEditorStore.getState().forceReloadNoteContent(tab.noteId, {
                title: detail.title,
                content: detail.content,
            });
            clearNoteExternalConflict(tab.noteId);
        } catch (error) {
            console.error("Error reloading note from disk:", error);
        }
    }, [clearNoteExternalConflict]);

    const keepLocalNoteVersion = useCallback(() => {
        const tab = activeTabRef.current;
        if (!tab) return;
        clearNoteExternalConflict(tab.noteId);
    }, [clearNoteExternalConflict]);

    const scheduleSave = useCallback(
        (tabId: string, doc: Text | string) => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                const freshTab = useEditorStore
                    .getState()
                    .tabs.find((t) => t.id === tabId);
                if (freshTab && isNoteTab(freshTab))
                    saveNow(
                        freshTab,
                        typeof doc === "string" ? doc : doc.toString(),
                    );
            }, 300);
        },
        [saveNow],
    );
    useEffect(() => {
        scheduleSaveRef.current = scheduleSave;
    }, [scheduleSave]);

    const applyFrontmatterChange = useCallback(
        (nextFrontmatter: string | null) => {
            const tab = activeTabRef.current;
            const view = viewRef.current;
            if (!tab) return;

            if (nextFrontmatter) {
                frontmatterByTabId.current.set(tab.noteId, nextFrontmatter);
            } else {
                frontmatterByTabId.current.delete(tab.noteId);
            }

            // Sync the editor document: replace/insert/remove frontmatter block.
            if (view) {
                const doc = view.state.doc.toString();
                const fmMatch = doc.match(FRONTMATTER_RE);
                const oldEnd = fmMatch ? fmMatch[0].length : 0;
                const insert = nextFrontmatter ?? "";
                if (insert !== doc.slice(0, oldEnd)) {
                    view.dispatch({
                        changes: { from: 0, to: oldEnd, insert },
                    });
                }
            }

            // After dispatch, getCurrentBody() returns the updated doc.
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
            scheduleSave(tab.id, body);
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
                frontmatterByTabId.current.get(tab.noteId) ?? activeFrontmatter;
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
            scheduleSave(tab.id, nextBody);
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

    const handleTitleContextMenu = useCallback(
        async (event: React.MouseEvent<HTMLTextAreaElement>) => {
            event.preventDefault();
            event.stopPropagation();
            setEditorContextMenu(null);
            setLinkContextMenu(null);
            setEmbedContextMenu(null);
            setSelectionToolbar(null);
            const target = event.currentTarget;
            const selectionStart = target.selectionStart ?? 0;
            const selectionEnd = target.selectionEnd ?? 0;
            const hasSelection = selectionEnd > selectionStart;
            const wordRange = findTextInputWordRange(
                target.value,
                selectionStart,
                selectionEnd,
            );
            const wordText = wordRange
                ? target.value.slice(wordRange.from, wordRange.to).trim()
                : null;
            let spellingSuggestions: string[] = [];
            let spellingCorrect: boolean | null = null;
            let grammarDiagnostics: SpellcheckGrammarContextDiagnostic[] = [];

            if (
                titleSpellcheckEnabled &&
                wordText &&
                isSpellcheckCandidate(wordText)
            ) {
                try {
                    const response = await loadSpellcheckSuggestions(
                        wordText,
                        titleSpellcheckLanguage ?? spellcheckPrimaryLanguage,
                    );
                    spellingSuggestions = response.suggestions;
                    spellingCorrect = response.correct;
                } catch (error) {
                    console.error(
                        "Error loading title spellcheck suggestions:",
                        error,
                    );
                }
            }

            if (grammarCheckEnabled && target.value.trim().length > 0) {
                try {
                    const diagnostics = await loadGrammarDiagnostics(
                        target.value,
                        spellcheckPrimaryLanguage,
                    );
                    const grammarSelectionStart = selectionStart;
                    const grammarSelectionEnd = hasSelection
                        ? selectionEnd
                        : selectionStart;

                    grammarDiagnostics = diagnostics
                        .filter((diagnostic) =>
                            hasSelection
                                ? diagnostic.start_utf16 <
                                      grammarSelectionEnd &&
                                  diagnostic.end_utf16 > grammarSelectionStart
                                : grammarSelectionStart >=
                                      diagnostic.start_utf16 &&
                                  grammarSelectionStart <= diagnostic.end_utf16,
                        )
                        .map((diagnostic) => ({
                            message: diagnostic.message,
                            replacements: diagnostic.replacements,
                            range: {
                                from: diagnostic.start_utf16,
                                to: diagnostic.end_utf16,
                            },
                        }));
                } catch (error) {
                    console.error(
                        "Error loading title grammar suggestions:",
                        error,
                    );
                }
            }

            setTitleContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: {
                    hasSelection,
                    spellingWord: wordText,
                    spellingCorrect,
                    wordRange,
                    spellingSuggestions,
                    secondaryLanguage: spellcheckSecondaryLanguage,
                    secondaryLanguageCandidates:
                        getSecondaryLanguageCandidates(),
                    grammarDiagnostics,
                },
            });
        },
        [
            grammarCheckEnabled,
            spellcheckPrimaryLanguage,
            spellcheckSecondaryLanguage,
            titleSpellcheckEnabled,
            titleSpellcheckLanguage,
        ],
    );

    const handleSearchClick = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        if (searchPanelOpen(view.state)) {
            closeSearchPanel(view);
        } else {
            openSearchPanel(view);
        }
    }, []);

    const syncDerivedTitle = useCallback(
        (body: string, tab: NoteTab | null = activeTabRef.current) => {
            if (!tab) return null;

            const nextTitle = deriveDisplayedTitle(
                frontmatterByTabId.current.get(tab.noteId) ?? null,
                body,
                tab.title,
            );

            if (activeTabRef.current?.id === tab.id) {
                setEditableTitle(nextTitle);
            }

            if (nextTitle !== tab.title) {
                updateTabTitle(tab.id, nextTitle);
                updateNoteMetadata(tab.noteId, {
                    title: nextTitle,
                    modified_at: Math.floor(Date.now() / 1000),
                });
            }

            return nextTitle;
        },
        [updateNoteMetadata, updateTabTitle],
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
            setEmbedContextMenu(null);
            setLinkContextMenu(menu);
        },
        [],
    );

    const handleRecoverableCoordinateLookupError = useCallback(
        (error: unknown, source: string) => {
            if (!isRecoverableCoordinateLookupError(error)) {
                throw error;
            }
            if (!didLogCoordinateLookupErrorRef.current) {
                didLogCoordinateLookupErrorRef.current = true;
                console.warn(
                    `Ignoring transient CodeMirror coordinate lookup failure in ${source}.`,
                    error,
                );
            }
            return null;
        },
        [],
    );

    const safeCoordsAtPos = useCallback(
        (view: EditorView, pos: number, side?: 1 | -1) => {
            try {
                return view.coordsAtPos(pos, side);
            } catch (error) {
                return handleRecoverableCoordinateLookupError(
                    error,
                    "coordsAtPos",
                );
            }
        },
        [handleRecoverableCoordinateLookupError],
    );

    const safePosAtCoords = useCallback(
        (view: EditorView, coords: { x: number; y: number }) => {
            try {
                return view.posAtCoords(coords);
            } catch (error) {
                return handleRecoverableCoordinateLookupError(
                    error,
                    "posAtCoords",
                );
            }
        },
        [handleRecoverableCoordinateLookupError],
    );

    const updateSelectionToolbar = useCallback(
        (view: EditorView | null) => {
            const hasActiveSelection =
                view &&
                activeTabRef.current &&
                view.hasFocus &&
                view.state.selection.ranges.length === 1 &&
                !view.state.selection.main.empty;

            if (!hasActiveSelection) {
                // Only update if there was a previous selection
                if (useEditorStore.getState().currentSelection !== null) {
                    useEditorStore.getState().clearCurrentSelection();
                }
                clearEditorDomSelection(view);
                syncSelectionLayerVisibility(view);
                setSelectionToolbar((prev) => (prev === null ? prev : null));
                return;
            }

            const selection = view.state.selection.main;
            const selectionStart = safeCoordsAtPos(view, selection.from, 1);
            const selectionEnd = safeCoordsAtPos(
                view,
                Math.max(selection.from, selection.to - 1),
                -1,
            );
            if (!selectionStart || !selectionEnd) {
                if (useEditorStore.getState().currentSelection !== null) {
                    useEditorStore.getState().clearCurrentSelection();
                }
                clearEditorDomSelection(view);
                syncSelectionLayerVisibility(view);
                setSelectionToolbar((prev) => (prev === null ? prev : null));
                return;
            }

            syncSelectionLayerVisibility(view);
            const startLine = view.state.doc.lineAt(selection.from).number;
            const endLine = view.state.doc.lineAt(
                Math.max(selection.from, selection.to - 1),
            ).number;
            useEditorStore.getState().setCurrentSelection({
                noteId: activeTabRef.current!.noteId,
                path: null,
                text: view.state.sliceDoc(selection.from, selection.to),
                from: selection.from,
                to: selection.to,
                startLine,
                endLine,
            });
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
        },
        [safeCoordsAtPos],
    );

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

    const applyEditorTransform = useCallback(
        (
            getTransform: (
                state: EditorState,
            ) => SelectionTransformResult | null,
        ) => {
            const view = viewRef.current;
            if (!view) return false;

            const transform = getTransform(view.state);
            if (!transform) return false;

            view.dispatch({
                changes: transform.changes,
                selection: transform.selection,
                scrollIntoView: true,
                userEvent: transform.userEvent,
            });
            view.focus();
            updateSelectionToolbar(view);
            return true;
        },
        [updateSelectionToolbar],
    );

    const applyHeadingCommand = useCallback(
        (level: HeadingLevel) =>
            applyEditorTransform((state) => getHeadingTransform(state, level)),
        [applyEditorTransform],
    );

    const applyBlockquoteCommand = useCallback(
        () => applyEditorTransform(getBlockquoteTransform),
        [applyEditorTransform],
    );

    const applyCodeBlockCommand = useCallback(
        () => applyEditorTransform(getCodeBlockTransform),
        [applyEditorTransform],
    );

    const applyHorizontalRuleCommand = useCallback(
        () => applyEditorTransform(getHorizontalRuleTransform),
        [applyEditorTransform],
    );

    const applyCodeBlockLanguageCommand = useCallback(() => {
        const view = viewRef.current;
        if (!view) return false;

        const currentLanguage = getCodeBlockLanguageAtSelection(view.state);
        if (currentLanguage === null) return false;

        const nextLanguage = window.prompt(
            "Code block language",
            currentLanguage,
        );
        if (nextLanguage === null) return false;

        return applyEditorTransform((state) =>
            getSetCodeBlockLanguageTransform(state, nextLanguage),
        );
    }, [applyEditorTransform]);

    const handleAddSelectionToChat = useCallback(() => {
        useChatStore.getState().attachSelectionFromEditor();
        setSelectionToolbar(null);
    }, []);

    const updateWikilinkSuggester = useCallback(
        (view: EditorView | null) => {
            if (!view || !activeTabRef.current || !view.hasFocus) {
                wikilinkSuggestionRequestIdRef.current += 1;
                wikilinkSuggesterArmedRef.current = false;
                setWikilinkSuggester((prev) => (prev === null ? prev : null));
                return;
            }

            const context = getWikilinkContext(view.state);
            if (!context) {
                wikilinkSuggestionRequestIdRef.current += 1;
                wikilinkSuggesterArmedRef.current = false;
                setWikilinkSuggester((prev) => (prev === null ? prev : null));
                return;
            }

            if (!wikilinkSuggesterArmedRef.current) {
                wikilinkSuggestionRequestIdRef.current += 1;
                setWikilinkSuggester((prev) => (prev === null ? prev : null));
                return;
            }

            const caret = safeCoordsAtPos(view, view.state.selection.main.head);
            if (!caret) {
                wikilinkSuggestionRequestIdRef.current += 1;
                setWikilinkSuggester(null);
                return;
            }

            const requestId = ++wikilinkSuggestionRequestIdRef.current;
            const activeNoteId = activeTabRef.current.noteId;
            const { left, top } = caret;

            void getWikilinkSuggestions(activeNoteId, context.query)
                .then((items) => {
                    if (requestId !== wikilinkSuggestionRequestIdRef.current)
                        return;
                    setWikilinkSuggester((previous) => ({
                        x: left,
                        y: top,
                        query: context.query,
                        selectedIndex: previous
                            ? Math.min(
                                  previous.selectedIndex,
                                  Math.max(items.length - 1, 0),
                              )
                            : 0,
                        items,
                        wholeFrom: context.wholeFrom,
                        wholeTo: context.wholeTo,
                    }));
                })
                .catch((error) => {
                    if (requestId !== wikilinkSuggestionRequestIdRef.current)
                        return;
                    console.error("Error loading wikilink suggestions:", error);
                    setWikilinkSuggester((previous) => ({
                        x: left,
                        y: top,
                        query: context.query,
                        selectedIndex: 0,
                        items:
                            previous?.query === context.query
                                ? previous.items
                                : [],
                        wholeFrom: context.wholeFrom,
                        wholeTo: context.wholeTo,
                    }));
                });
        },
        [safeCoordsAtPos],
    );

    const moveWikilinkSuggesterSelection = useCallback((direction: 1 | -1) => {
        const suggester = wikilinkSuggesterRef.current;
        if (!suggester || !suggester.items.length) return false;

        setWikilinkSuggester((previous) => {
            if (!previous || !previous.items.length) return previous;
            const itemCount = previous.items.length;
            return {
                ...previous,
                selectedIndex:
                    (previous.selectedIndex + direction + itemCount) %
                    itemCount,
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
            wikilinkSuggestionRequestIdRef.current += 1;
            setWikilinkSuggester(null);
            return true;
        },
        [],
    );

    const closeWikilinkSuggester = useCallback(() => {
        if (!wikilinkSuggesterRef.current) return false;
        wikilinkSuggesterArmedRef.current = false;
        wikilinkSuggestionRequestIdRef.current += 1;
        setWikilinkSuggester(null);
        return true;
    }, []);

    const loadSpellcheckSuggestions = useCallback(
        async (
            word: string,
            language = useSettingsStore.getState().spellcheckPrimaryLanguage,
        ) => {
            return useSpellcheckStore.getState().suggestWord(word, language);
        },
        [],
    );

    const loadGrammarDiagnostics = useCallback(
        async (
            text: string,
            language = useSettingsStore.getState().spellcheckPrimaryLanguage,
        ) => {
            const response = await spellcheckCheckGrammar(
                text,
                language,
                useSettingsStore.getState().grammarCheckServerUrl || undefined,
            );
            return response.diagnostics;
        },
        [],
    );

    const refreshEditorSpellcheck = useCallback(() => {
        const view = viewRef.current;
        const noteId = activeTabRef.current?.noteId ?? null;
        if (!view) return;

        view.dispatch({
            effects: spellcheckDecorationsCompartment.reconfigure(
                getSpellcheckEditorExtension({
                    enabled: useSettingsStore.getState().editorSpellcheck,
                    primaryLanguage:
                        useSettingsStore.getState().spellcheckPrimaryLanguage,
                    secondaryLanguage:
                        useSettingsStore.getState().spellcheckSecondaryLanguage,
                    noteId,
                }),
            ),
        });
    }, []);

    const getSecondaryLanguageCandidates = useCallback(() => {
        const excludedPrimaryLanguages = new Set(
            resolveFrontendSpellcheckLanguageCandidates(
                useSettingsStore.getState().spellcheckPrimaryLanguage,
            ),
        );
        const excludedPrimaryFamilies = new Set(
            [...excludedPrimaryLanguages].map(
                (language) => language.split("-")[0]?.toLowerCase() ?? language,
            ),
        );
        const currentSecondary =
            useSettingsStore.getState().spellcheckSecondaryLanguage;

        return useSpellcheckStore
            .getState()
            .languages.filter(
                (language) =>
                    language.available &&
                    !excludedPrimaryLanguages.has(language.id) &&
                    !excludedPrimaryFamilies.has(
                        language.id.split("-")[0]?.toLowerCase() ?? language.id,
                    ),
            )
            .map((language) => ({
                id: language.id,
                label: language.label,
            }))
            .sort((left, right) => {
                if (left.id === currentSecondary) return -1;
                if (right.id === currentSecondary) return 1;
                return left.label.localeCompare(right.label, "en");
            })
            .slice(0, 3);
    }, []);

    const handleEditorContextMenu = useCallback(
        async (event: {
            clientX: number;
            clientY: number;
            target: EventTarget | null;
            preventDefault: () => void;
            stopPropagation?: () => void;
        }) => {
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

            if (
                target?.closest("textarea, input, [contenteditable='true']") &&
                !target.closest(".cm-content")
            ) {
                return false;
            }

            const liveLink = target?.closest(
                ".cm-lp-link",
            ) as HTMLElement | null;
            if (liveLink?.dataset.href) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
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

            const wikilink = target?.closest(
                ".cm-wikilink",
            ) as HTMLElement | null;
            if (wikilink?.dataset.wikilinkTarget) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
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
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
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

            const tableUrl = target?.closest(
                ".cm-lp-table-url",
            ) as HTMLElement | null;
            if (tableUrl?.dataset.url) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
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

            const tableWikilink = target?.closest(
                ".cm-lp-table-wikilink",
            ) as HTMLElement | null;
            if (tableWikilink?.dataset.wikilinkTarget) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: tableWikilink.dataset.wikilinkTarget,
                    noteTarget: tableWikilink.dataset.wikilinkTarget,
                });
                return true;
            }

            const noteEmbed = target?.closest(
                ".cm-note-embed",
            ) as HTMLElement | null;
            if (noteEmbed?.dataset.wikilinkTarget) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: noteEmbed.dataset.wikilinkTarget,
                    noteTarget: noteEmbed.dataset.wikilinkTarget,
                });
                return true;
            }

            const embedEl = target?.closest(
                "[data-embed-target]",
            ) as HTMLElement | null;
            if (embedEl?.dataset.embedTarget && embedEl.dataset.embedKind) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setLinkContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setEmbedContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    payload: undefined,
                    target: embedEl.dataset.embedTarget,
                    kind: embedEl.dataset.embedKind as "pdf" | "image",
                });
                return true;
            }

            const youtubeLink = target?.closest(
                ".cm-youtube-link",
            ) as HTMLElement | null;
            if (youtubeLink?.dataset.href) {
                event.preventDefault();
                event.stopPropagation?.();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
                setEmbedContextMenu(null);
                setSelectionToolbar(null);
                wikilinkSuggesterArmedRef.current = false;
                setLinkContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    href: youtubeLink.dataset.href,
                    noteTarget: null,
                });
                return true;
            }

            if (target?.closest(EDITOR_INTERACTIVE_PREVIEW_SELECTOR)) {
                return false;
            }

            const pos = safePosAtCoords(view, {
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
            event.stopPropagation?.();
            setSelectionToolbar(null);
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
            setLinkContextMenu(null);
            setEmbedContextMenu(null);
            setTitleContextMenu(null);
            const hasSelection = !view.state.selection.main.empty;
            const canCheckSpelling =
                useSettingsStore.getState().editorSpellcheck &&
                typeof activeTabRef.current?.noteId === "string" &&
                activeTabRef.current.noteId.length > 0;
            const word = pos !== null ? view.state.wordAt(pos) : null;
            const wordText =
                word && word.from !== word.to
                    ? view.state.sliceDoc(word.from, word.to).trim()
                    : null;
            const shouldFetchSuggestions =
                canCheckSpelling &&
                !!wordText &&
                /[\p{L}\p{M}]/u.test(wordText);
            const requestId = ++spellcheckRequestIdRef.current;
            let spellingSuggestions: string[] = [];
            let spellingCorrect: boolean | null = null;

            if (shouldFetchSuggestions) {
                try {
                    const response = await loadSpellcheckSuggestions(wordText);
                    spellingSuggestions = response.suggestions;
                    spellingCorrect = response.correct;
                } catch (error) {
                    console.error(
                        "Error loading spellcheck suggestions:",
                        error,
                    );
                }
            }

            if (requestId !== spellcheckRequestIdRef.current) {
                return true;
            }

            // Look up grammar diagnostic at click position
            const grammarNoteId = activeTabRef.current?.noteId ?? "";
            const grammarDiagnostics =
                pos !== null && grammarNoteId
                    ? findGrammarDiagnosticsAt(grammarNoteId, pos)
                    : [];

            setEditorContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: {
                    hasSelection,
                    spellingWord: shouldFetchSuggestions ? wordText : null,
                    spellingCorrect: shouldFetchSuggestions
                        ? spellingCorrect
                        : null,
                    wordRange:
                        shouldFetchSuggestions && word
                            ? { from: word.from, to: word.to }
                            : null,
                    spellingSuggestions,
                    secondaryLanguage: spellcheckSecondaryLanguage,
                    secondaryLanguageCandidates:
                        getSecondaryLanguageCandidates(),
                    grammarDiagnostics: grammarDiagnostics.map(
                        (diagnostic) => ({
                            message: diagnostic.message,
                            replacements: diagnostic.replacements,
                            range: {
                                from: diagnostic.from,
                                to: diagnostic.to,
                            },
                        }),
                    ),
                },
            });
            return true;
        },
        [
            getSecondaryLanguageCandidates,
            loadSpellcheckSuggestions,
            safePosAtCoords,
            spellcheckSecondaryLanguage,
        ],
    );

    useEffect(() => {
        const whenEditorReady = () =>
            viewRef.current !== null && activeTabRef.current !== null;
        const platform = getDesktopPlatform();
        const commands = [
            {
                id: "editor:heading-1",
                label: "Heading 1",
                shortcut: formatPrimaryShortcut("1", platform),
                execute: () => {
                    applyHeadingCommand(1);
                },
            },
            {
                id: "editor:heading-2",
                label: "Heading 2",
                shortcut: formatPrimaryShortcut("2", platform),
                execute: () => {
                    applyHeadingCommand(2);
                },
            },
            {
                id: "editor:heading-3",
                label: "Heading 3",
                shortcut: formatPrimaryShortcut("3", platform),
                execute: () => {
                    applyHeadingCommand(3);
                },
            },
            {
                id: "editor:heading-4",
                label: "Heading 4",
                shortcut: formatPrimaryShortcut("4", platform),
                execute: () => {
                    applyHeadingCommand(4);
                },
            },
            {
                id: "editor:heading-5",
                label: "Heading 5",
                shortcut: formatPrimaryShortcut("5", platform),
                execute: () => {
                    applyHeadingCommand(5);
                },
            },
            {
                id: "editor:heading-6",
                label: "Heading 6",
                shortcut: formatPrimaryShortcut("6", platform),
                execute: () => {
                    applyHeadingCommand(6);
                },
            },
            {
                id: "editor:heading-0",
                label: "Remove Heading",
                shortcut: formatPrimaryShortcut("0", platform),
                execute: () => {
                    applyHeadingCommand(0);
                },
            },
            {
                id: "editor:blockquote",
                label: "Toggle Blockquote",
                execute: () => {
                    applyBlockquoteCommand();
                },
            },
            {
                id: "editor:code-block",
                label: "Insert Code Block",
                execute: () => {
                    applyCodeBlockCommand();
                },
            },
            {
                id: "editor:horizontal-rule",
                label: "Insert Horizontal Rule",
                execute: () => {
                    applyHorizontalRuleCommand();
                },
            },
            {
                id: "editor:code-block-language",
                label: "Set Code Block Language",
                execute: () => {
                    applyCodeBlockLanguageCommand();
                },
            },
        ] as const;

        for (const command of commands) {
            registerCommand({
                ...command,
                category: "Editor",
                when: whenEditorReady,
            });
        }

        return () => {
            for (const command of commands) {
                unregisterCommand(command.id);
            }
        };
    }, [
        applyBlockquoteCommand,
        applyCodeBlockCommand,
        applyCodeBlockLanguageCommand,
        applyHeadingCommand,
        applyHorizontalRuleCommand,
        registerCommand,
        unregisterCommand,
    ]);

    // Factory to create a fresh EditorState with all extensions
    const createEditorState = useCallback(
        (
            doc: string,
            noteId: string | null = activeTabRef.current?.noteId ?? null,
        ) => {
            return EditorState.create({
                doc,
                extensions: [
                    history(),
                    markdown({
                        base: markdownLanguage,
                        codeLanguages: resolveMarkdownCodeLanguage,
                    }),
                    baseTheme,
                    syntaxCompartment.of(
                        getSyntaxExtension(useThemeStore.getState().isDark),
                    ),
                    wrappingCompartment.of(
                        getWrappingExtension(
                            useSettingsStore.getState().lineWrapping,
                        ),
                    ),
                    drawSelection(),
                    alignmentCompartment.of(
                        getAlignmentExtension(
                            useSettingsStore.getState().justifyText &&
                                useSettingsStore.getState().lineWrapping,
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
                    spellcheckCompartment.of(
                        getSpellcheckExtension(
                            useSettingsStore.getState().editorSpellcheck,
                            useSettingsStore.getState()
                                .spellcheckPrimaryLanguage,
                            useSettingsStore.getState()
                                .spellcheckSecondaryLanguage,
                            noteId,
                        ),
                    ),
                    spellcheckDecorationsCompartment.of(
                        getSpellcheckEditorExtension({
                            enabled:
                                useSettingsStore.getState().editorSpellcheck,
                            primaryLanguage:
                                useSettingsStore.getState()
                                    .spellcheckPrimaryLanguage,
                            secondaryLanguage:
                                useSettingsStore.getState()
                                    .spellcheckSecondaryLanguage,
                            noteId,
                        }),
                    ),
                    grammarDecorationsCompartment.of(
                        getGrammarEditorExtension({
                            enabled:
                                useSettingsStore.getState().grammarCheckEnabled,
                            primaryLanguage:
                                useSettingsStore.getState()
                                    .spellcheckPrimaryLanguage,
                            serverUrl:
                                useSettingsStore.getState()
                                    .grammarCheckServerUrl,
                            noteId,
                        }),
                    ),
                    mergeViewCompartment.of([]),
                    livePreviewCompartment.of(
                        getLivePreviewExtension(
                            handleOpenLinkContextMenu,
                            useSettingsStore.getState().livePreviewEnabled,
                        ),
                    ),
                    search({
                        top: true,
                        createPanel: createMarkdownSearchPanel,
                    }),
                    markdownSearchMatchTheme,
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
                        {
                            key: "Mod-l",
                            run: (view) => {
                                if (view.state.selection.main.empty)
                                    return false;
                                useChatStore
                                    .getState()
                                    .attachSelectionFromEditor();
                                setSelectionToolbar(null);
                                return true;
                            },
                        },
                        {
                            key: "Mod-1",
                            run: () => applyHeadingCommand(1),
                        },
                        {
                            key: "Mod-2",
                            run: () => applyHeadingCommand(2),
                        },
                        {
                            key: "Mod-3",
                            run: () => applyHeadingCommand(3),
                        },
                        {
                            key: "Mod-4",
                            run: () => applyHeadingCommand(4),
                        },
                        {
                            key: "Mod-5",
                            run: () => applyHeadingCommand(5),
                        },
                        {
                            key: "Mod-6",
                            run: () => applyHeadingCommand(6),
                        },
                        {
                            key: "Mod-0",
                            run: () => applyHeadingCommand(0),
                        },
                        {
                            key:
                                getCodeMirrorShortcut("highlight_selection") ??
                                "Mod-Shift-h",
                            run: (view) => {
                                const transform = getSelectionTransform(
                                    view.state,
                                    "highlight",
                                );
                                if (!transform) return false;
                                view.dispatch({
                                    changes: transform.changes,
                                    selection: transform.selection,
                                    scrollIntoView: true,
                                    userEvent: transform.userEvent,
                                });
                                return true;
                            },
                        },
                        {
                            key:
                                getCodeMirrorShortcut("bold_selection") ??
                                "Mod-b",
                            run: (view) => {
                                const transform = getSelectionTransform(
                                    view.state,
                                    "bold",
                                );
                                if (!transform) return false;
                                view.dispatch({
                                    changes: transform.changes,
                                    selection: transform.selection,
                                    scrollIntoView: true,
                                    userEvent: transform.userEvent,
                                });
                                return true;
                            },
                        },
                        ...defaultKeymap,
                        ...historyKeymap,
                        ...searchKeymap,
                    ]),
                    wikilinkExtension(
                        resolveWikilinksBatch,
                        () => activeTabRef.current?.noteId ?? null,
                        navigateWikilink,
                    ),
                    urlLinksExtension,
                    imagePasteDropExtension(),
                    fileTreeDropExtension(),
                    EditorView.updateListener.of((update) => {
                        if (!update.docChanged || isInternalRef.current) return;
                        const tab = activeTabRef.current;
                        if (!tab) return;
                        // Capture the immutable doc reference — defer toString()
                        // to the debounce callbacks instead of on every keystroke.
                        const doc = update.state.doc;
                        if (contentUpdateTimerRef.current)
                            clearTimeout(contentUpdateTimerRef.current);
                        contentUpdateTimerRef.current = setTimeout(() => {
                            const content = doc.toString();
                            updateTabContent(tab.id, content);
                        }, 300);
                        syncDerivedTitle(doc.toString(), tab);
                        scheduleSaveRef.current(tab.id, doc);
                    }),
                    userEditNotifier(
                        () => {
                            const noteId = activeTabRef.current?.noteId;
                            return noteId ? `${noteId}.md` : null;
                        },
                        (fileId, textEdits, fullText) => {
                            useChatStore
                                .getState()
                                .notifyUserEditOnFile(
                                    fileId,
                                    textEdits,
                                    fullText,
                                );
                        },
                    ),
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

                        // Skip toolbar/suggester updates for effect-only
                        // transactions (e.g. async wikilink resolution
                        // callbacks) — they don't change the document,
                        // selection, or viewport.
                        if (
                            !update.docChanged &&
                            !update.selectionSet &&
                            !update.viewportChanged &&
                            !update.focusChanged
                        ) {
                            return;
                        }

                        updateSelectionToolbar(update.view);
                        updateWikilinkSuggester(update.view);
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
            applyHeadingCommand,
            syncDerivedTitle,
            updateTabContent,
        ],
    );

    const replaceEditorView = useCallback(
        (state: EditorState) => {
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
            setEditorView(nextView);
            attachScrollHeader(nextView);

            if (shouldRestoreFocus) {
                nextView.focus();
            }

            const handleScrollOrResize = () => {
                updateSelectionToolbar(nextView);
                updateWikilinkSuggester(nextView);
            };
            const handleNativeContextMenu = (event: MouseEvent) => {
                void handleEditorContextMenu(event);
            };

            nextView.scrollDOM.addEventListener(
                "scroll",
                handleScrollOrResize,
                {
                    passive: true,
                },
            );
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
        },
        [
            attachScrollHeader,
            handleEditorContextMenu,
            updateSelectionToolbar,
            updateWikilinkSuggester,
        ],
    );

    // Initialize CodeMirror once — container is always in the DOM
    useEffect(() => {
        if (!containerRef.current) return;

        const initialTab = activeTabRef.current;
        const rawContent = initialTab?.content ?? "";
        const body = initialTab
            ? stripFrontmatter(initialTab.noteId, rawContent)
            : rawContent;
        if (initialTab) {
            markTabSaved(initialTab.noteId, rawContent);
        }

        replaceEditorView(createEditorState(body, initialTab?.noteId ?? null));

        setActiveFrontmatter(
            initialTab
                ? (frontmatterByTabId.current.get(initialTab.noteId) ?? null)
                : null,
        );
        setEditableTitle(
            initialTab
                ? deriveDisplayedTitle(
                      frontmatterByTabId.current.get(initialTab.noteId) ?? null,
                      body,
                      initialTab.title,
                  )
                : "",
        );
        prevTabIdRef.current = initialTab?.id ?? null;
        prevNoteIdRef.current = initialTab?.noteId ?? null;

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            if (contentUpdateTimerRef.current)
                clearTimeout(contentUpdateTimerRef.current);
            if (externalReloadTimerRef.current) {
                clearTimeout(externalReloadTimerRef.current);
                externalReloadTimerRef.current = null;
            }
            if (mergeSyncTimerRef.current) {
                clearTimeout(mergeSyncTimerRef.current);
                mergeSyncTimerRef.current = null;
            }
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
            setEditorView(null);
            setSelectionToolbar(null);
            wikilinkSuggesterArmedRef.current = false;
            setWikilinkSuggester(null);
        };
        // stable deps — createEditorState, replaceEditorView and stripFrontmatter only depend on stable refs
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [markTabSaved]);

    // Switch tabs or navigate within tab: save previous state, restore or create new state.
    // Fires on activeTabId change (tab switch) OR activeTabInfo.noteId change (in-tab navigation).
    const activeNoteId = activeTabInfo?.noteId ?? null;
    useEffect(() => {
        const currentView = viewRef.current;
        if (!currentView) return;

        const prevTabId = prevTabIdRef.current;
        const prevNoteId = prevNoteIdRef.current;
        const tabChanged = prevTabId !== activeTabId;
        const noteChanged = prevNoteId !== activeNoteId;
        if (!tabChanged && !noteChanged) return;

        prevTabIdRef.current = activeTabId;
        prevNoteIdRef.current = activeNoteId;

        const previousContent = currentView.state.doc.toString();
        const previousTab = prevTabId
            ? (useEditorStore.getState().tabs.find((t) => t.id === prevTabId) ??
              null)
            : null;

        // Cancel any pending autosave (prevents saving to wrong note)
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        // Flush pending content update so the tab's content is up-to-date
        if (contentUpdateTimerRef.current) {
            clearTimeout(contentUpdateTimerRef.current);
            contentUpdateTimerRef.current = null;
            if (prevTabId) {
                updateTabContent(prevTabId, previousContent);
            }
        }

        // Save previous note's EditorState and viewport position (keyed by noteId)
        if (prevNoteId && (tabChanged || noteChanged)) {
            tabStatesRef.current.set(prevNoteId, currentView.state);
            saveTabScrollPosition(prevNoteId, currentView);
        }
        if (
            prevNoteId &&
            (tabChanged || noteChanged) &&
            previousTab &&
            isTabDirty(prevNoteId, previousContent)
        ) {
            void saveNow(
                {
                    ...previousTab,
                    // For in-tab navigation, previousTab.noteId may already be updated.
                    // Use prevNoteId to ensure we save to the correct note.
                    noteId: prevNoteId,
                    content: previousContent,
                },
                previousContent,
            );
        }

        if (!activeTabId || !activeTab || !activeNoteId) return;

        if (!lastSavedContentByTabId.current.has(activeNoteId)) {
            markTabSaved(activeNoteId, activeTab.content);
        }

        // Restore saved state or create fresh one (keyed by noteId)
        const savedState = tabStatesRef.current.get(activeNoteId);
        const nextState =
            savedState ??
            createEditorState(
                stripFrontmatter(activeNoteId, activeTab.content),
                activeNoteId,
            );
        // Recreate the EditorView on document switches. Reusing the same view
        // via setState has left the DOM occasionally blank until a later rerender.
        isInternalRef.current = true;
        const view = replaceEditorView(nextState);
        isInternalRef.current = false;
        if (!view) return;

        // Re-insert scroll header if setState detached it
        if (
            scrollHeaderRef.current &&
            !view.scrollDOM.contains(scrollHeaderRef.current)
        ) {
            attachScrollHeader(view);
        }

        restoreTabScrollPosition(activeNoteId, view);
        updateSelectionToolbar(view);
        updateWikilinkSuggester(view);

        // Update frontmatter panel for this note
        setActiveFrontmatter(
            frontmatterByTabId.current.get(activeNoteId) ?? null,
        );
        setEditableTitle(
            deriveDisplayedTitle(
                frontmatterByTabId.current.get(activeNoteId) ?? null,
                nextState.doc.toString(),
                activeTab.title,
            ),
        );

        // Reconfigure syntax/live-preview only on actual tab switch —
        // within the same tab the compartments are already correct.
        if (tabChanged) {
            view.dispatch({
                effects: [
                    syntaxCompartment.reconfigure(
                        getSyntaxExtension(useThemeStore.getState().isDark),
                    ),
                    livePreviewCompartment.reconfigure(
                        getLivePreviewExtension(
                            handleOpenLinkContextMenu,
                            useSettingsStore.getState().livePreviewEnabled,
                        ),
                    ),
                    spellcheckCompartment.reconfigure(
                        getSpellcheckExtension(
                            useSettingsStore.getState().editorSpellcheck,
                            useSettingsStore.getState()
                                .spellcheckPrimaryLanguage,
                            useSettingsStore.getState()
                                .spellcheckSecondaryLanguage,
                            activeNoteId,
                        ),
                    ),
                    spellcheckDecorationsCompartment.reconfigure(
                        getSpellcheckEditorExtension({
                            enabled:
                                useSettingsStore.getState().editorSpellcheck,
                            primaryLanguage:
                                useSettingsStore.getState()
                                    .spellcheckPrimaryLanguage,
                            secondaryLanguage:
                                useSettingsStore.getState()
                                    .spellcheckSecondaryLanguage,
                            noteId: activeNoteId,
                        }),
                    ),
                    grammarDecorationsCompartment.reconfigure(
                        getGrammarEditorExtension({
                            enabled:
                                useSettingsStore.getState().grammarCheckEnabled,
                            primaryLanguage:
                                useSettingsStore.getState()
                                    .spellcheckPrimaryLanguage,
                            serverUrl:
                                useSettingsStore.getState()
                                    .grammarCheckServerUrl,
                            noteId: activeNoteId,
                        }),
                    ),
                    // Reset merge view to empty — syncMergeViewForPaths will
                    // re-enable it with fresh data in a later effect.
                    mergeViewCompartment.reconfigure([]),
                ],
            });
        }
        // Register file baseline for active AI sessions (pre-write snapshot)
        if (activeTab.content != null) {
            const sessions = useChatStore.getState().sessionsById;
            const fileId = `${activeNoteId}.md`;
            for (const [sid, session] of Object.entries(sessions)) {
                if (
                    session.status === "streaming" ||
                    session.status === "idle"
                ) {
                    aiRegisterFileBaseline(
                        sid,
                        fileId,
                        activeTab.content,
                    ).catch(() => {});
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        activeTabId,
        activeNoteId,
        activeTab?.content,
        attachScrollHeader,
        isTabDirty,
        markTabSaved,
        restoreTabScrollPosition,
        saveNow,
        saveTabScrollPosition,
        updateTabContent,
        updateSelectionToolbar,
        updateWikilinkSuggester,
    ]);

    useEffect(() => {
        if (activeTabInfo) return;
        setSelectionToolbar(null);
        wikilinkSuggesterArmedRef.current = false;
        setWikilinkSuggester(null);
    }, [activeTabInfo]);

    useEffect(() => {
        if (activeTabInfo) return;
        let mounted = true;
        let unlisten: (() => void) | null = null;
        void getCurrentWebview()
            .onDragDropEvent((event) => {
                const type = event.payload.type;
                if (type === "enter" || type === "over") {
                    setIsDraggingVault(true);
                } else if (type === "drop") {
                    setIsDraggingVault(false);
                    const path = event.payload.paths[0];
                    if (path) void openVault(path);
                } else {
                    setIsDraggingVault(false);
                }
            })
            .then((fn) => {
                if (mounted) unlisten = fn;
                else fn();
            });
        return () => {
            mounted = false;
            unlisten?.();
        };
    }, [activeTabInfo, openVault]);

    // Reconfigure syntax theme when isDark changes
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: syntaxCompartment.reconfigure(getSyntaxExtension(isDark)),
        });
    }, [isDark]);

    // Reconfigure live preview when vault metadata or the setting changes
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: [
                livePreviewCompartment.reconfigure(
                    getLivePreviewExtension(
                        handleOpenLinkContextMenu,
                        livePreviewEnabled,
                    ),
                ),
            ],
        });
        scheduleMergeViewSync();
    }, [
        handleOpenLinkContextMenu,
        livePreviewEnabled,
        scheduleMergeViewSync,
        vaultPath,
    ]);

    useEffect(() => {
        runMergeViewSync();
        const unsub = useChatStore.subscribe((state) => {
            void state.sessionsById;
            scheduleMergeViewSync({ preferDebounce: true });
        });
        return unsub;
    }, [runMergeViewSync, scheduleMergeViewSync]);

    useEffect(() => {
        return subscribeEditorReviewSync(() =>
            resolveEditorTargetForOpenTab(activeTabRef.current),
        );
    }, [activeTabId, activeNoteId]);

    useEffect(() => {
        scheduleMergeViewSync();
    }, [activeTabId, activeNoteId, livePreviewEnabled, scheduleMergeViewSync]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: [
                spellcheckCompartment.reconfigure(
                    getSpellcheckExtension(
                        editorSpellcheck,
                        spellcheckPrimaryLanguage,
                        spellcheckSecondaryLanguage,
                        activeNoteId,
                    ),
                ),
                spellcheckDecorationsCompartment.reconfigure(
                    getSpellcheckEditorExtension({
                        enabled: editorSpellcheck,
                        primaryLanguage: spellcheckPrimaryLanguage,
                        secondaryLanguage: spellcheckSecondaryLanguage,
                        noteId: activeNoteId,
                    }),
                ),
                grammarDecorationsCompartment.reconfigure(
                    getGrammarEditorExtension({
                        enabled: grammarCheckEnabled,
                        primaryLanguage: spellcheckPrimaryLanguage,
                        serverUrl: grammarCheckServerUrl,
                        noteId: activeNoteId,
                    }),
                ),
            ],
        });
    }, [
        activeNoteId,
        editorSpellcheck,
        spellcheckPrimaryLanguage,
        spellcheckSecondaryLanguage,
        grammarCheckEnabled,
        grammarCheckServerUrl,
    ]);

    // Reload editor content when an external process (e.g. AI agent) writes to the file
    useEffect(() => {
        const unsub = useEditorStore.subscribe((state, prev) => {
            const view = viewRef.current;
            if (!view) return;
            const tabId = state.activeTabId;
            if (!tabId) return;

            const tab = state.tabs.find((t) => t.id === tabId);
            const prevTab = prev.tabs.find((t) => t.id === tabId);
            if (!tab || !prevTab) return;
            if (!isNoteTab(tab) || !isNoteTab(prevTab)) return;

            // Skip when noteId changed — the tab-switch useEffect handles navigation
            if (tab.noteId !== prevTab.noteId) return;
            const reloadVersion = state._noteReloadVersions?.[tab.noteId] ?? 0;
            const prevReloadVersion =
                prev._noteReloadVersions?.[tab.noteId] ?? 0;

            const isForced =
                state._pendingForceReloads?.has(tab.noteId) ?? false;

            if (reloadVersion === prevReloadVersion && !isForced) {
                return;
            }

            const currentDoc = view.state.doc.toString();
            const currentSerialized = serializePersistedContent(
                tab.noteId,
                currentDoc,
            );
            const lastSaved =
                lastSavedContentByTabId.current.get(tab.noteId) ?? null;
            const hasLocalUnsavedChanges =
                lastSaved !== null && currentSerialized !== lastSaved;
            const incomingSerialized = tab.content;
            const reloadMeta = (state._noteReloadMetadata?.[tab.noteId] ??
                null) as ReloadedNoteMetadata | null;
            const incomingOrigin = reloadMeta?.origin ?? "unknown";
            const incomingOpId = reloadMeta?.opId ?? null;
            const incomingRevision = reloadMeta?.revision ?? 0;
            const lastAckRevision =
                lastAckRevisionByTabId.current.get(tab.noteId) ?? 0;
            const pendingLocalOpId =
                pendingLocalOpIdByTabId.current.get(tab.noteId) ?? null;
            const isPendingLocalSaveAck =
                !isForced &&
                incomingOrigin === "user" &&
                incomingOpId !== null &&
                incomingOpId === pendingLocalOpId;
            const isStaleRevision =
                !isForced &&
                incomingRevision > 0 &&
                incomingRevision <= lastAckRevision &&
                !isPendingLocalSaveAck;
            const incoming = stripFrontmatter(tab.noteId, incomingSerialized);
            const nextFrontmatter =
                frontmatterByTabId.current.get(tab.noteId) ?? null;
            const nextTitle = deriveDisplayedTitle(
                nextFrontmatter,
                incoming,
                tab.title,
            );
            const incomingMatchesCurrentDoc =
                incomingSerialized === currentSerialized;
            const acknowledgeIncomingRevision = () => {
                if (incomingRevision <= 0) return;
                lastAckRevisionByTabId.current.set(
                    tab.noteId,
                    Math.max(lastAckRevision, incomingRevision),
                );
            };
            const clearPendingLocalAck = () => {
                if (isPendingLocalSaveAck) {
                    pendingLocalOpIdByTabId.current.delete(tab.noteId);
                }
            };

            if (isStaleRevision) {
                clearPendingLocalAck();
                return;
            }

            if (!isForced && incomingMatchesCurrentDoc) {
                acknowledgeIncomingRevision();
                clearPendingLocalAck();
                if (lastSaved !== incomingSerialized) {
                    markTabSaved(tab.noteId, incomingSerialized);
                }
                useEditorStore.getState().clearNoteExternalConflict(tab.noteId);
                if (activeTabRef.current?.id === tabId) {
                    setActiveFrontmatter(nextFrontmatter);
                    setEditableTitle(nextTitle);
                }
                return;
            }

            if (hasLocalUnsavedChanges && !isForced) {
                if (isPendingLocalSaveAck) {
                    acknowledgeIncomingRevision();
                    clearPendingLocalAck();
                    markTabSaved(tab.noteId, incomingSerialized);
                    useEditorStore
                        .getState()
                        .clearNoteExternalConflict(tab.noteId);
                    return;
                }
                useEditorStore.getState().markNoteExternalConflict(tab.noteId);
                return;
            }
            if (isForced) {
                useEditorStore.getState().clearForceReload(tab.noteId);
            }
            acknowledgeIncomingRevision();
            clearPendingLocalAck();
            useEditorStore.getState().clearNoteExternalConflict(tab.noteId);

            if (activeTabRef.current?.id === tabId) {
                setActiveFrontmatter(nextFrontmatter);
                setEditableTitle(nextTitle);
            }
            if (incoming !== currentDoc) {
                markTabSaved(tab.noteId, incomingSerialized);
            }
            if (incoming === currentDoc) return;

            const applyReload = () => {
                externalReloadTimerRef.current = null;

                const liveView = viewRef.current;
                const liveTab = useEditorStore
                    .getState()
                    .tabs.find((candidate) => candidate.id === tabId);
                if (
                    !liveView ||
                    !liveTab ||
                    !isNoteTab(liveTab) ||
                    liveTab.noteId !== tab.noteId
                ) {
                    return;
                }

                const liveDoc = liveView.state.doc.toString();
                if (liveDoc === incoming) {
                    scheduleMergeViewSync();
                    return;
                }

                const selection = liveView.state.selection.main;
                const nextDocLength = incoming.length;
                const effects = [mergeViewCompartment.reconfigure([])];
                try {
                    if (liveView.state.doc.length > 0) {
                        effects.unshift(liveView.scrollSnapshot());
                    }

                    isInternalRef.current = true;
                    liveView.dispatch({
                        changes: {
                            from: 0,
                            to: liveDoc.length,
                            insert: incoming,
                        },
                        selection: {
                            anchor: Math.min(selection.anchor, nextDocLength),
                            head: Math.min(selection.head, nextDocLength),
                        },
                        annotations: [changeAuthorAnnotation.of("agent")],
                        effects,
                    });
                    isInternalRef.current = false;
                } catch (error) {
                    isInternalRef.current = false;
                    if (error instanceof RangeError) {
                        const fallbackSelection = Math.min(
                            selection.anchor,
                            nextDocLength,
                        );
                        const nextState = createEditorState(
                            incoming,
                            liveTab.noteId,
                        ).update({
                            selection: {
                                anchor: fallbackSelection,
                                head: Math.min(selection.head, nextDocLength),
                            },
                        }).state;
                        replaceEditorView(nextState);
                    } else {
                        throw error;
                    }
                }

                scheduleMergeViewSync();
            };

            if (externalReloadTimerRef.current) {
                clearTimeout(externalReloadTimerRef.current);
            }
            externalReloadTimerRef.current = setTimeout(applyReload, 0);
        });
        return unsub;
    }, [
        createEditorState,
        markTabSaved,
        replaceEditorView,
        scheduleMergeViewSync,
        serializePersistedContent,
        stripFrontmatter,
    ]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: [
                alignmentCompartment.reconfigure(
                    getAlignmentExtension(justifyText && lineWrapping),
                ),
                wrappingCompartment.reconfigure(
                    getWrappingExtension(lineWrapping),
                ),
                tabSizeCompartment.reconfigure([
                    EditorState.tabSize.of(tabSize),
                    indentUnit.of(" ".repeat(tabSize)),
                ]),
            ],
        });
    }, [justifyText, lineWrapping, tabSize]);

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

        const docLen = view.state.doc.length;
        const clampedAnchor = Math.max(
            0,
            Math.min(pendingSelectionReveal.anchor, docLen),
        );
        const clampedHead = Math.max(
            0,
            Math.min(pendingSelectionReveal.head, docLen),
        );
        view.dispatch({
            selection: { anchor: clampedAnchor, head: clampedHead },
            scrollIntoView: true,
        });
        view.focus();
        clearPendingSelectionReveal();
    }, [activeTab, pendingSelectionReveal, clearPendingSelectionReveal]);

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            const platform = getDesktopPlatform();
            const { tabs, activeTabId } = useEditorStore.getState();

            // Cmd+W / Ctrl+W: close active tab
            if (matchesShortcutAction(e, "close_tab", platform)) {
                e.preventDefault();
                closeActiveTabWithSave();
                return;
            }

            // Cmd+Shift+S / Ctrl+Shift+S: save active tab immediately
            if (matchesShortcutAction(e, "save_note", platform)) {
                const tab = tabs.find((item) => item.id === activeTabId);
                if (!tab || !isNoteTab(tab)) return;
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

            // Cmd+[ / Ctrl+[: go back in history
            if ((e.metaKey || e.ctrlKey) && e.key === "[") {
                e.preventDefault();
                useEditorStore.getState().goBack();
            }

            // Cmd+] / Ctrl+]: go forward in history
            if ((e.metaKey || e.ctrlKey) && e.key === "]") {
                e.preventDefault();
                useEditorStore.getState().goForward();
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [closeActiveTabWithSave, saveNow]);

    useEffect(() => {
        const handleCloseRequest = () => {
            closeActiveTabWithSave();
        };

        window.addEventListener(
            REQUEST_CLOSE_ACTIVE_TAB_EVENT,
            handleCloseRequest,
        );
        return () =>
            window.removeEventListener(
                REQUEST_CLOSE_ACTIVE_TAB_EVENT,
                handleCloseRequest,
            );
    }, [closeActiveTabWithSave]);

    const editorShellStyle = {
        "--editor-font-size": `${editorFontSize}px`,
        "--editor-font-family": getEditorFontFamily(editorFontFamily),
        "--text-input-line-height": String(editorLineHeight / 100),
        "--editor-content-width": `${editorContentWidth}px`,
    } as CSSProperties;

    const activeLocation = activeTabInfo
        ? getNoteLocation(activeTabInfo.noteId)
        : { parent: "" };
    const addWordToSpellcheckDictionary = async (word: string) => {
        await useSpellcheckStore
            .getState()
            .addWordToDictionary(word, spellcheckPrimaryLanguage);
        refreshEditorSpellcheck();
    };
    const ignoreWordForSpellcheckSession = async (word: string) => {
        await useSpellcheckStore
            .getState()
            .ignoreWordForSession(word, spellcheckPrimaryLanguage);
        refreshEditorSpellcheck();
    };
    const editorContextMenuEntries = buildSpellcheckContextMenuEntries({
        payload: editorContextMenu?.payload,
        applySuggestion: (suggestion, range) => {
            const view = viewRef.current;
            if (!view) return;

            view.dispatch({
                changes: {
                    from: range.from,
                    to: range.to,
                    insert: suggestion,
                },
                selection: EditorSelection.cursor(
                    range.from + suggestion.length,
                ),
                scrollIntoView: true,
                userEvent: "input",
            });
            view.focus();
        },
        addToDictionary: (word) => {
            void addWordToSpellcheckDictionary(word);
        },
        ignoreForSession: (word) => {
            void ignoreWordForSpellcheckSession(word);
        },
        setSecondaryLanguage: (language) => {
            useSettingsStore
                .getState()
                .setSetting("spellcheckSecondaryLanguage", language);
            refreshEditorSpellcheck();
        },
        spellcheckAction: {
            label: editorSpellcheck
                ? "Disable Spellcheck"
                : "Enable Spellcheck",
            action: () => {
                useSettingsStore
                    .getState()
                    .setSetting("editorSpellcheck", !editorSpellcheck);
            },
        },
        trailingEntries: [
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
                disabled: !editorContextMenu?.payload.hasSelection,
            },
            {
                label: "Copy",
                action: () => void copySelectedText(),
                disabled: !editorContextMenu?.payload.hasSelection,
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
        ],
    });
    const titleContextMenuEntries = buildSpellcheckContextMenuEntries({
        payload: titleContextMenu?.payload,
        applySuggestion: (suggestion, range) => {
            const input = titleInputRef.current;
            if (!input) return;

            const nextTitle =
                editableTitle.slice(0, range.from) +
                suggestion +
                editableTitle.slice(range.to);
            applyTitleChange(nextTitle);
            input.focus();
            input.setSelectionRange(range.from, range.from + suggestion.length);
        },
        addToDictionary: (word) => {
            void addWordToSpellcheckDictionary(word);
        },
        ignoreForSession: (word) => {
            void ignoreWordForSpellcheckSession(word);
        },
        setSecondaryLanguage: (language) => {
            useSettingsStore
                .getState()
                .setSetting("spellcheckSecondaryLanguage", language);
            refreshEditorSpellcheck();
        },
        spellcheckAction: null,
        trailingEntries: [
            {
                label: "Rename Note",
                action: () => {
                    titleInputRef.current?.focus();
                    titleInputRef.current?.select();
                },
            },
            {
                label: "Copy Title",
                action: () => void navigator.clipboard.writeText(editableTitle),
            },
        ],
    });

    // Always render the container so CodeMirror initializes properly
    return (
        <div
            className="editor-shell h-full overflow-hidden flex flex-col"
            style={editorShellStyle}
        >
            {activeTabInfo && hasExternalConflict && (
                <div
                    className="flex items-center justify-between gap-3 px-4 py-2"
                    style={{
                        borderBottom:
                            "1px solid color-mix(in srgb, #f59e0b 35%, var(--border))",
                        background:
                            "color-mix(in srgb, #f59e0b 12%, var(--bg-secondary))",
                    }}
                >
                    <div
                        className="min-w-0 text-[12px]"
                        style={{ color: "var(--text-primary)" }}
                    >
                        This note changed on disk while you still have unsaved
                        edits.
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => void reloadNoteFromDisk()}
                            className="rounded-md px-2.5 py-1 text-[11px]"
                            style={{
                                border: "1px solid color-mix(in srgb, #f59e0b 45%, var(--border))",
                                backgroundColor: "var(--bg-primary)",
                                color: "var(--text-primary)",
                            }}
                        >
                            Reload from Disk
                        </button>
                        <button
                            type="button"
                            onClick={keepLocalNoteVersion}
                            className="rounded-md px-2.5 py-1 text-[11px]"
                            style={{
                                border: "1px solid transparent",
                                backgroundColor: "transparent",
                                color: "var(--text-secondary)",
                            }}
                        >
                            Keep Local
                        </button>
                    </div>
                </div>
            )}
            <div className="min-h-0 flex-1 relative">
                <div className="flex h-full min-w-0">
                    <div className="min-w-0 flex-1 relative">
                        <div
                            ref={containerRef}
                            className="h-full relative z-1"
                        />
                    </div>
                </div>
                {!activeTabInfo && (
                    <div
                        className="absolute inset-0 z-2 flex items-center justify-center select-none pointer-events-none"
                        style={{
                            background: isDraggingVault
                                ? "color-mix(in srgb, var(--accent) 6%, var(--bg-primary))"
                                : "var(--bg-primary)",
                            transition: "background 0.15s ease",
                        }}
                    >
                        <p
                            style={{
                                fontSize: 13,
                                color: "var(--text-secondary)",
                            }}
                        >
                            {isDraggingVault
                                ? "Drop folder to open as vault"
                                : emptyStateMessage}
                        </p>
                    </div>
                )}
                {selectionToolbar && (
                    <FloatingSelectionToolbar
                        toolbar={selectionToolbar}
                        editorElement={viewRef.current?.dom ?? null}
                        onAction={handleSelectionToolbarAction}
                        onAddToChat={handleAddSelectionToChat}
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
                    <MarkdownNoteHeader
                        editableTitle={editableTitle}
                        onTitleChange={applyTitleChange}
                        titleInputRef={titleInputRef}
                        onTitleContextMenu={handleTitleContextMenu}
                        locationParent={activeLocation.parent}
                        frontmatterRaw={activeFrontmatter}
                        onFrontmatterChange={applyFrontmatterChange}
                        propertiesExpanded={propertiesExpanded}
                        onToggleProperties={() =>
                            setPropertiesExpanded((prev) => !prev)
                        }
                        onSearchClick={handleSearchClick}
                    />,
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
            {embedContextMenu && (
                <EmbedContextMenu
                    menu={embedContextMenu}
                    onClose={() => setEmbedContextMenu(null)}
                />
            )}
            {editorContextMenu && (
                <ContextMenu
                    menu={editorContextMenu}
                    onClose={() => setEditorContextMenu(null)}
                    minWidth={138}
                    entries={editorContextMenuEntries}
                />
            )}
            {titleContextMenu && (
                <ContextMenu
                    menu={titleContextMenu}
                    onClose={() => setTitleContextMenu(null)}
                    entries={titleContextMenuEntries}
                />
            )}
            {searchContextMenu && (
                <ContextMenu
                    menu={{
                        x: searchContextMenu.x,
                        y: searchContextMenu.y,
                        payload: undefined,
                    }}
                    onClose={() => setSearchContextMenu(null)}
                    minWidth={140}
                    entries={[
                        {
                            label: `${searchContextMenu.options.caseSensitive ? "✓ " : "   "}Match Case`,
                            action: () =>
                                searchContextMenu.toggle("caseSensitive"),
                        },
                        {
                            label: `${searchContextMenu.options.regexp ? "✓ " : "   "}Regular Expression`,
                            action: () => searchContextMenu.toggle("regexp"),
                        },
                        {
                            label: `${searchContextMenu.options.wholeWord ? "✓ " : "   "}Whole Word`,
                            action: () => searchContextMenu.toggle("wholeWord"),
                        },
                    ]}
                />
            )}
        </div>
    );
}
