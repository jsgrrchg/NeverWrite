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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { useShallow } from "zustand/react/shallow";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { getWindowMode } from "../../app/detachedWindows";
import { findWikilinks } from "../../app/utils/wikilinks";
import { useEditorStore, type Tab } from "../../app/store/editorStore";
import { useThemeStore } from "../../app/store/themeStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { wikilinkExtension } from "./extensions/wikilinks";
import { urlLinksExtension } from "./extensions/urlLinks";
import { searchTheme } from "./extensions/searchTheme";
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
import { MetaBadge, EditableNoteTitle } from "./EditorHeader";
import { LinkContextMenu } from "./LinkContextMenu";
import {
    type LinkContextMenuState,
    baseTheme,
    syntaxCompartment,
    livePreviewCompartment,
    alignmentCompartment,
    tabSizeCompartment,
    getSyntaxExtension,
    getLivePreviewExtension,
    getAlignmentExtension,
    getEditorFontFamily,
} from "./editorExtensions";
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
import { FrontmatterPanel } from "./FrontmatterPanel";
import {
    getSelectionTransform,
    type SelectionToolbarAction,
} from "./selectionTransforms";
import {
    WikilinkSuggester,
    type WikilinkSuggesterState,
} from "./WikilinkSuggester";

const appWindow = getCurrentWindow();

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
type EditorContextMenuPayload = {
    hasSelection: boolean;
};

interface EditorProps {
    emptyStateMessage?: string;
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
    const restoreScrollFrameRef = useRef<number | null>(null);
    const selectionToolbarCleanupRef = useRef<(() => void) | null>(null);
    const activeTabRef = useRef<Tab | null>(null);
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
    // Frontmatter: stores the raw ---...--- block per note so we can restore it on save
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
    const [isDraggingVault, setIsDraggingVault] = useState(false);
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
    const isDark = useThemeStore((s) => s.isDark);
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
    const editorLineHeight = useSettingsStore((s) => s.editorLineHeight);
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const justifyText = useSettingsStore((s) => s.justifyText);
    const livePreviewEnabled = useSettingsStore((s) => s.livePreviewEnabled);
    const tabSize = useSettingsStore((s) => s.tabSize);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);
    const touchContent = useVaultStore((s) => s.touchContent);
    const openVault = useVaultStore((s) => s.openVault);

    // Only re-renders when the active tab identity changes, not on content updates
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

    const serializePersistedContent = useCallback(
        (tabId: string, body: string) =>
            `${frontmatterByTabId.current.get(tabId) ?? ""}${body}`,
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
            tab: Pick<Tab, "id" | "noteId" | "title" | "content">,
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
            try {
                const detail = await vaultInvoke<SavedNoteDetail>("save_note", {
                    noteId: tab.noteId,
                    content: serializedContent,
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
                touchContent();
            } catch (e) {
                console.error("Error al guardar nota:", e);
            }
        },
        [
            markTabSaved,
            serializePersistedContent,
            stripFrontmatter,
            touchContent,
            updateNoteMetadata,
            updateTabTitle,
        ],
    );

    const scheduleSave = useCallback(
        (tabId: string, doc: Text | string) => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                const freshTab = useEditorStore
                    .getState()
                    .tabs.find((t) => t.id === tabId);
                if (freshTab)
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
            if (!tab) return;

            if (nextFrontmatter) {
                frontmatterByTabId.current.set(tab.noteId, nextFrontmatter);
            } else {
                frontmatterByTabId.current.delete(tab.noteId);
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
        const selectionStart = view.coordsAtPos(selection.from, 1);
        const selectionEnd = view.coordsAtPos(
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
        useEditorStore.getState().setCurrentSelection({
            noteId: activeTabRef.current!.noteId,
            text: view.state.sliceDoc(selection.from, selection.to),
            from: selection.from,
            to: selection.to,
        });
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

        const caret = view.coordsAtPos(view.state.selection.main.head);
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
                        previous?.query === context.query ? previous.items : [],
                    wholeFrom: context.wholeFrom,
                    wholeTo: context.wholeTo,
                }));
            });
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

    const handleEditorContextMenu = useCallback(
        (event: {
            clientX: number;
            clientY: number;
            target: EventTarget | null;
            preventDefault: () => void;
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

            const liveLink = target?.closest(
                ".cm-lp-link",
            ) as HTMLElement | null;
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

            const wikilink = target?.closest(
                ".cm-wikilink",
            ) as HTMLElement | null;
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

            const tableUrl = target?.closest(
                ".cm-lp-table-url",
            ) as HTMLElement | null;
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

            const tableWikilink = target?.closest(
                ".cm-lp-table-wikilink",
            ) as HTMLElement | null;
            if (tableWikilink?.dataset.wikilinkTarget) {
                event.preventDefault();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
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
                setEditorContextMenu(null);
                setTitleContextMenu(null);
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

            const youtubeLink = target?.closest(
                ".cm-youtube-link",
            ) as HTMLElement | null;
            if (youtubeLink?.dataset.href) {
                event.preventDefault();
                setEditorContextMenu(null);
                setTitleContextMenu(null);
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
                            handleOpenLinkContextMenu,
                            useSettingsStore.getState().livePreviewEnabled,
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
                    wikilinkExtension(
                        resolveWikilinksBatch,
                        () => activeTabRef.current?.noteId ?? null,
                        navigateWikilink,
                    ),
                    urlLinksExtension,
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
                        scheduleSaveRef.current(tab.id, doc);
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

        replaceEditorView(createEditorState(body));

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
            );
        // Swap state in-place — avoids destroying/recreating the entire DOM.
        // Falls back to replaceEditorView if setState throws.
        let view: EditorView | null = currentView;
        isInternalRef.current = true;
        try {
            currentView.setState(nextState);
        } catch {
            view = replaceEditorView(nextState);
        }
        isInternalRef.current = false;
        if (!view) return;

        // Re-insert scroll header if setState detached it
        if (
            scrollHeaderRef.current &&
            !view.scrollDOM.contains(scrollHeaderRef.current)
        ) {
            view.scrollDOM.insertBefore(
                scrollHeaderRef.current,
                view.contentDOM,
            );
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
                ],
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        activeTabId,
        activeNoteId,
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
            effects: livePreviewCompartment.reconfigure(
                getLivePreviewExtension(
                    handleOpenLinkContextMenu,
                    livePreviewEnabled,
                ),
            ),
        });
    }, [handleOpenLinkContextMenu, vaultPath, livePreviewEnabled]);

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

            // Skip when noteId changed — the tab-switch useEffect handles navigation
            if (tab.noteId !== prevTab.noteId) return;

            if (
                tab.content === prevTab.content &&
                tab.title === prevTab.title
            ) {
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
            const incoming = stripFrontmatter(tab.noteId, tab.content);
            const nextFrontmatter =
                frontmatterByTabId.current.get(tab.noteId) ?? null;
            const nextTitle = deriveDisplayedTitle(
                nextFrontmatter,
                incoming,
                tab.title,
            );

            if (hasLocalUnsavedChanges) {
                return;
            }

            if (activeTabRef.current?.id === tabId) {
                setActiveFrontmatter(nextFrontmatter);
                setEditableTitle(nextTitle);
            }
            if (incoming !== currentDoc) {
                markTabSaved(tab.noteId, tab.content);
            }
            if (incoming === currentDoc) return;

            const selection = view.state.selection.main;
            const scrollTop = view.scrollDOM.scrollTop;
            const scrollLeft = view.scrollDOM.scrollLeft;
            const nextDocLength = incoming.length;

            isInternalRef.current = true;
            view.dispatch({
                changes: {
                    from: 0,
                    to: currentDoc.length,
                    insert: incoming,
                },
                selection: {
                    anchor: Math.min(selection.anchor, nextDocLength),
                    head: Math.min(selection.head, nextDocLength),
                },
            });
            isInternalRef.current = false;
            requestAnimationFrame(() => {
                if (viewRef.current !== view) return;
                view.scrollDOM.scrollTop = scrollTop;
                view.scrollDOM.scrollLeft = scrollLeft;
            });
        });
        return unsub;
    }, [markTabSaved, serializePersistedContent, stripFrontmatter]);

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
            const { tabs, activeTabId, closeTab, switchTab } =
                useEditorStore.getState();

            // Cmd+W / Ctrl+W: close active tab
            if ((e.metaKey || e.ctrlKey) && e.key === "w") {
                e.preventDefault();
                if (activeTabId) {
                    const tab = tabs.find((t) => t.id === activeTabId);
                    if (tab) {
                        const content =
                            viewRef.current?.state.doc.toString() ??
                            tab.content;
                        saveNow(tab, content);
                    }
                    // Clean up saved EditorState for all notes in this tab's history
                    if (tab) {
                        for (const entry of tab.history ?? []) {
                            tabStatesRef.current.delete(entry.noteId);
                        }
                    }
                    tabStatesRef.current.delete(tab?.noteId ?? activeTabId);
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
                <div ref={containerRef} className="h-full relative z-1" />
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
                                void navigator.clipboard.writeText(
                                    editableTitle,
                                ),
                        },
                    ]}
                />
            )}
        </div>
    );
}
