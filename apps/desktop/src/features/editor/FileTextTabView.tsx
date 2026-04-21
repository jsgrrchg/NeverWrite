import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { redo, undo } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
    search,
    searchKeymap,
    openSearchPanel,
    closeSearchPanel,
    searchPanelOpen,
} from "@codemirror/search";
import {
    EditorView,
    drawSelection,
    keymap,
    lineNumbers,
} from "@codemirror/view";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useThemeStore } from "../../app/store/themeStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    baseTheme,
    getEditorFontFamily,
    getEditorHorizontalInset,
    getSyntaxExtension,
    getWrappingExtension,
} from "./editorExtensions";
import { mergeViewCompartment } from "./extensions/mergeViewDiff";
import { syncMergeViewForPaths } from "./mergeViewSync";
import { aiRegisterFileBaseline } from "../ai/api";
import { useChatStore } from "../ai/store/chatStore";
import { getCodeMirrorShortcut } from "../../app/shortcuts/registry";
import { loadCodeLanguage } from "./codeLanguage";
import { searchTheme } from "./extensions/searchTheme";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";
import { resolveEditorTargetForOpenTab } from "./editorTargetResolver";
import { subscribeEditorReviewSync } from "./editorReviewSync";
import { shouldEnableInlineReviewMergeView } from "./editorReviewGate";
import { useEditableFileResource } from "./useEditableFileResource";
import { logError } from "../../app/utils/runtimeLog";
import {
    changeAuthorAnnotation,
    userEditNotifier,
} from "./extensions/changeAuthor";

interface FileTextTabViewProps {
    paneId?: string;
}

export function FileTextTabView({ paneId }: FileTextTabViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const syntaxCompartmentRef = useRef(new Compartment());
    const wrappingCompartmentRef = useRef(new Compartment());
    const languageCompartmentRef = useRef(new Compartment());
    const loadRequestRef = useRef(0);
    const contextMenuCleanupRef = useRef<(() => void) | null>(null);
    const applyingExternalUpdateRef = useRef(false);
    const [, setEditorView] = useState<EditorView | null>(null);
    const [editorContextMenu, setEditorContextMenu] =
        useState<ContextMenuState<{
            hasSelection: boolean;
        }> | null>(null);
    const isDark = useThemeStore((s) => s.isDark);
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
    const editorLineHeight = useSettingsStore((s) => s.editorLineHeight);
    const editorAutosaveDelayMs = useSettingsStore(
        (s) => s.editorAutosaveDelayMs,
    );
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const lineWrapping = useSettingsStore((s) => s.lineWrapping);
    const inlineReviewEnabled = useSettingsStore((s) => s.inlineReviewEnabled);
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const getCurrentContent = useCallback(
        () => viewRef.current?.state.doc.toString() ?? null,
        [],
    );
    const replaceEditorDocument = useCallback((nextContent: string) => {
        const view = viewRef.current;
        if (!view) {
            return;
        }

        const currentContent = view.state.doc.toString();
        if (currentContent === nextContent) {
            return;
        }

        const selection = view.state.selection.main;
        applyingExternalUpdateRef.current = true;
        view.dispatch({
            changes: {
                from: 0,
                to: currentContent.length,
                insert: nextContent,
            },
            selection: {
                anchor: Math.min(selection.anchor, nextContent.length),
                head: Math.min(selection.head, nextContent.length),
            },
            annotations: [changeAuthorAnnotation.of("agent")],
        });
        applyingExternalUpdateRef.current = false;
    }, []);

    const {
        tab,
        tabRef,
        hasExternalConflict,
        handleLocalContentChange,
        reloadFileFromDisk,
        keepLocalFileVersion,
        flushCurrentSave,
    } = useEditableFileResource({
        paneId,
        getCurrentContent,
        applyIncomingContent: replaceEditorDocument,
        autosaveDelayMs: editorAutosaveDelayMs,
    });
    const languagePath = tab?.path ?? null;
    const languageMimeType = tab?.mimeType ?? null;
    const trackedFileMatch = tab
        ? resolveTrackedFileMatchForPaths(
              [tab.path, tab.relativePath],
              sessionsById,
              {
                  vaultPath,
              },
          ).match
        : null;

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
            logError("file-editor", "Failed to copy file selection", error);
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
            logError("file-editor", "Failed to cut file selection", error);
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
            logError("file-editor", "Failed to paste into file editor", error);
        }
    }, []);

    const selectAllText = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;

        view.dispatch({
            selection: EditorSelection.single(0, view.state.doc.length),
        });
        view.focus();
    }, []);

    const handleEditorContextMenu = useCallback((event: MouseEvent) => {
        const view = viewRef.current;
        if (!view) return;

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
        event.stopPropagation();

        setEditorContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: {
                hasSelection: !view.state.selection.main.empty,
            },
        });
    }, []);

    const syncCurrentSelection = useCallback(
        (view: EditorView) => {
            const selection = view.state.selection.main;
            if (selection.empty) {
                useEditorStore.getState().clearCurrentSelection();
                return;
            }

            const currentTab = tabRef.current;
            if (!currentTab) {
                useEditorStore.getState().clearCurrentSelection();
                return;
            }

            const startLine = view.state.doc.lineAt(selection.from).number;
            const endLine = view.state.doc.lineAt(
                Math.max(selection.from, selection.to - 1),
            ).number;
            useEditorStore.getState().setCurrentSelection({
                noteId: null,
                path: currentTab.path,
                text: view.state.sliceDoc(selection.from, selection.to),
                from: selection.from,
                to: selection.to,
                startLine,
                endLine,
            });
        },
        [tabRef],
    );

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !tab) {
            return;
        }

        if (viewRef.current) {
            return;
        }

        const nextView = new EditorView({
            state: EditorState.create({
                doc: tab.content,
                extensions: [
                    baseTheme,
                    wrappingCompartmentRef.current.of(
                        getWrappingExtension(lineWrapping),
                    ),
                    drawSelection(),
                    EditorView.editorAttributes.of({
                        "data-live-preview": "false",
                    }),
                    lineNumbers(),
                    search({ top: true }),
                    searchTheme,
                    keymap.of([
                        {
                            key:
                                getCodeMirrorShortcut("find_in_note") ??
                                "Mod-f",
                            run: (view) => {
                                if (searchPanelOpen(view.state)) {
                                    closeSearchPanel(view);
                                    return true;
                                }
                                return openSearchPanel(view);
                            },
                        },
                        ...searchKeymap,
                        {
                            key:
                                getCodeMirrorShortcut(
                                    "add_selection_to_chat",
                                ) ?? "Mod-l",
                            run: (view) => {
                                if (view.state.selection.main.empty) {
                                    return false;
                                }
                                syncCurrentSelection(view);
                                useChatStore
                                    .getState()
                                    .attachSelectionFromEditor();
                                return true;
                            },
                        },
                    ]),
                    mergeViewCompartment.of([]),
                    EditorView.updateListener.of((update) => {
                        if (update.selectionSet) {
                            syncCurrentSelection(update.view);
                        }

                        if (
                            !update.docChanged ||
                            applyingExternalUpdateRef.current
                        ) {
                            return;
                        }

                        const currentTab = tabRef.current;
                        if (!currentTab) {
                            return;
                        }

                        handleLocalContentChange(update.state.doc.toString());
                    }),
                    userEditNotifier(
                        () => tabRef.current?.path ?? null,
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
                    syntaxCompartmentRef.current.of(getSyntaxExtension(isDark)),
                    languageCompartmentRef.current.of([]),
                ],
            }),
            parent: container,
        });

        const handleNativeContextMenu = (event: MouseEvent) => {
            handleEditorContextMenu(event);
        };
        nextView.dom.addEventListener(
            "contextmenu",
            handleNativeContextMenu,
            true,
        );
        contextMenuCleanupRef.current = () => {
            nextView.dom.removeEventListener(
                "contextmenu",
                handleNativeContextMenu,
                true,
            );
        };

        viewRef.current = nextView;
        queueMicrotask(() => {
            setEditorView(nextView);
        });
    }, [
        handleLocalContentChange,
        handleEditorContextMenu,
        isDark,
        lineWrapping,
        syncCurrentSelection,
        tab,
        tabRef,
        trackedFileMatch?.trackedFile.diffBase,
    ]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }

        view.dispatch({
            effects: syntaxCompartmentRef.current.reconfigure(
                getSyntaxExtension(isDark),
            ),
        });
    }, [isDark]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }

        view.dispatch({
            effects: wrappingCompartmentRef.current.reconfigure(
                getWrappingExtension(lineWrapping),
            ),
        });
    }, [lineWrapping]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view || !tab) {
            return;
        }

        const requestId = loadRequestRef.current + 1;
        loadRequestRef.current = requestId;

        view.dispatch({
            effects: languageCompartmentRef.current.reconfigure([]),
        });

        void loadCodeLanguage(tab.path, tab.mimeType).then((extension) => {
            if (loadRequestRef.current !== requestId || !viewRef.current) {
                return;
            }

            viewRef.current.dispatch({
                effects: languageCompartmentRef.current.reconfigure(
                    extension ?? [],
                ),
            });
        });
    }, [languageMimeType, languagePath, tab]);

    useEffect(() => {
        const syncMerge = () => {
            const currentTab = tabRef.current;
            syncMergeViewForPaths(
                viewRef.current,
                shouldEnableInlineReviewMergeView("source") && currentTab
                    ? [currentTab.path, currentTab.relativePath]
                    : [],
                useChatStore.getState().sessionsById,
                { mode: "source" },
            );
        };

        syncMerge();
        const unsub = useChatStore.subscribe((state) => {
            const currentTab = tabRef.current;
            syncMergeViewForPaths(
                viewRef.current,
                shouldEnableInlineReviewMergeView("source") && currentTab
                    ? [currentTab.path, currentTab.relativePath]
                    : [],
                state.sessionsById,
                { mode: "source" },
            );
        });
        return unsub;
    }, [inlineReviewEnabled, tabRef]);

    const tabPath = tab?.path ?? null;
    const tabContent = tab?.content ?? null;

    useEffect(() => {
        if (!tabPath || tabContent == null) {
            return;
        }

        const sessions = useChatStore.getState().sessionsById;
        for (const [sessionId, session] of Object.entries(sessions)) {
            if (session.status !== "streaming" && session.status !== "idle") {
                continue;
            }

            aiRegisterFileBaseline(sessionId, tabPath, tabContent).catch(
                () => {},
            );
        }
    }, [tabPath, tabContent]);

    useEffect(() => {
        return subscribeEditorReviewSync(
            () => resolveEditorTargetForOpenTab(tabRef.current),
            () => viewRef.current?.state.doc.toString() ?? null,
        );
    }, [tab?.id, tab?.path, tab?.relativePath, tabRef]);

    useEffect(() => {
        const currentTab = tabRef.current;
        syncMergeViewForPaths(
            viewRef.current,
            shouldEnableInlineReviewMergeView("source") && currentTab
                ? [currentTab.path, currentTab.relativePath]
                : [],
            useChatStore.getState().sessionsById,
            { mode: "source" },
        );
    }, [
        inlineReviewEnabled,
        tab,
        tabRef,
        trackedFileMatch?.trackedFile.version,
    ]);

    useEffect(() => {
        queueMicrotask(() => setEditorContextMenu(null));
        useEditorStore.getState().clearCurrentSelection();
    }, [tab?.id]);

    useEffect(() => {
        return () => {
            flushCurrentSave();
            contextMenuCleanupRef.current?.();
            contextMenuCleanupRef.current = null;
            loadRequestRef.current += 1;
            useEditorStore.getState().clearCurrentSelection();
            viewRef.current?.destroy();
            viewRef.current = null;
            setEditorContextMenu(null);
            setEditorView(null);
        };
    }, [flushCurrentSave]);

    const editorShellStyle = {
        "--editor-font-size": `${editorFontSize}px`,
        "--editor-font-family": getEditorFontFamily(editorFontFamily),
        "--text-input-line-height": String(editorLineHeight / 100),
        "--editor-content-width": `${editorContentWidth}px`,
        "--editor-horizontal-inset": getEditorHorizontalInset(lineWrapping),
    } as CSSProperties;

    if (!tab) {
        return (
            <div
                className="h-full flex items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                No file tab active
            </div>
        );
    }

    return (
        <div
            className="editor-shell h-full overflow-hidden flex flex-col"
            style={editorShellStyle}
        >
            {hasExternalConflict && (
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
                        This file changed on disk while you still have unsaved
                        edits.
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => void reloadFileFromDisk()}
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
                            onClick={keepLocalFileVersion}
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
            <div
                className="flex items-center justify-between gap-2 px-3 shrink-0"
                style={{
                    height: 39,
                    borderBottom: "1px solid var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                }}
            >
                <div
                    className="min-w-0 truncate text-[11px]"
                    title={tab.relativePath}
                >
                    <span
                        className="font-medium"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {tab.title}
                    </span>
                    <span
                        className="ml-1.5"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {tab.relativePath}
                    </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => void openPath(tab.path)}
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-primary)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Open Externally
                    </button>
                    <button
                        type="button"
                        onClick={() => void revealItemInDir(tab.path)}
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-primary)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Reveal in Finder
                    </button>
                </div>
            </div>

            <div className="min-h-0 flex-1 relative">
                <div className="flex h-full min-w-0">
                    <div className="min-w-0 flex-1 relative">
                        <div
                            ref={containerRef}
                            className="h-full relative z-1"
                        />
                    </div>
                </div>
            </div>
            {editorContextMenu && (
                <ContextMenu
                    menu={editorContextMenu}
                    onClose={() => setEditorContextMenu(null)}
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
                            action: () => selectAllText(),
                        },
                    ]}
                />
            )}
        </div>
    );
}
