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
import { search, searchKeymap } from "@codemirror/search";
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
import {
    useEditorStore,
    isFileTab,
    type FileTab,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useThemeStore } from "../../app/store/themeStore";
import {
    baseTheme,
    getEditorFontFamily,
    getSyntaxExtension,
    getWrappingExtension,
} from "./editorExtensions";
import { mergeViewCompartment } from "./extensions/mergeViewDiff";
import { syncMergeViewForPaths } from "./mergeViewSync";
import { useChatStore } from "../ai/store/chatStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { loadCodeLanguage } from "./codeLanguage";
import { searchTheme } from "./extensions/searchTheme";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";

type SavedVaultFileDetail = {
    relative_path: string;
    file_name: string;
    content: string;
};

export function FileTextTabView() {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const syntaxCompartmentRef = useRef(new Compartment());
    const wrappingCompartmentRef = useRef(new Compartment());
    const languageCompartmentRef = useRef(new Compartment());
    const loadRequestRef = useRef(0);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tabRef = useRef<FileTab | null>(null);
    const contextMenuCleanupRef = useRef<(() => void) | null>(null);
    const applyingExternalUpdateRef = useRef(false);
    const lastSavedContentByPathRef = useRef(new Map<string, string>());
    const saveRequestIdByPathRef = useRef(new Map<string, number>());
    const [, setEditorView] = useState<EditorView | null>(null);
    const [editorContextMenu, setEditorContextMenu] =
        useState<ContextMenuState<{ hasSelection: boolean }> | null>(null);

    const tab = useEditorStore((state) => {
        return getActiveFileTab(state);
    });
    const isDark = useThemeStore((s) => s.isDark);
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
    const editorLineHeight = useSettingsStore((s) => s.editorLineHeight);
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const lineWrapping = useSettingsStore((s) => s.lineWrapping);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const languagePath = tab?.path ?? null;
    const languageMimeType = tab?.mimeType ?? null;
    const trackedFileMatch = tab
        ? resolveTrackedFileMatchForPaths(
              [tab.path, tab.relativePath],
              sessionsById,
          ).match
        : null;

    useEffect(() => {
        tabRef.current = tab;
    }, [tab]);

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
            console.error("Error copying file selection:", error);
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
            console.error("Error cutting file selection:", error);
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
            console.error("Error pasting into file editor:", error);
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

    const saveFile = useCallback(
        async (
            targetTab: NonNullable<ReturnType<typeof getActiveFileTab>>,
            content: string,
        ) => {
            const lastSaved = lastSavedContentByPathRef.current.get(
                targetTab.relativePath,
            );
            if (lastSaved === content) {
                return;
            }

            const requestId =
                (saveRequestIdByPathRef.current.get(targetTab.relativePath) ??
                    0) + 1;
            saveRequestIdByPathRef.current.set(
                targetTab.relativePath,
                requestId,
            );

            try {
                const detail = await vaultInvoke<SavedVaultFileDetail>(
                    "save_vault_file",
                    {
                        relativePath: targetTab.relativePath,
                        content,
                    },
                );
                if (
                    saveRequestIdByPathRef.current.get(
                        targetTab.relativePath,
                    ) !== requestId
                ) {
                    return;
                }
                lastSavedContentByPathRef.current.set(
                    targetTab.relativePath,
                    detail.content,
                );
                const store = useEditorStore.getState();
                store.updateTabTitle(targetTab.id, detail.file_name);
            } catch (error) {
                console.error("Error saving vault file:", error);
            }
        },
        [],
    );

    const scheduleSave = useCallback(
        (
            targetTab: NonNullable<ReturnType<typeof getActiveFileTab>>,
            content: string,
        ) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }

            saveTimerRef.current = setTimeout(() => {
                saveTimerRef.current = null;
                void saveFile(targetTab, content);
            }, 300);
        },
        [saveFile],
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
                    keymap.of(searchKeymap),
                    mergeViewCompartment.of([]),
                    EditorView.updateListener.of((update) => {
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

                        const content = update.state.doc.toString();
                        useEditorStore
                            .getState()
                            .updateTabContent(currentTab.id, content);
                        scheduleSave(currentTab, content);
                    }),
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
        handleEditorContextMenu,
        isDark,
        lineWrapping,
        scheduleSave,
        tab,
        trackedFileMatch?.trackedFile.diffBase,
    ]);

    useEffect(() => {
        if (!tab) {
            contextMenuCleanupRef.current?.();
            contextMenuCleanupRef.current = null;
            viewRef.current?.destroy();
            viewRef.current = null;
            queueMicrotask(() => {
                setEditorContextMenu(null);
                setEditorView(null);
            });
            loadRequestRef.current += 1;
            return;
        }

        const view = viewRef.current;
        if (!view) {
            return;
        }

        const currentContent = view.state.doc.toString();
        if (currentContent !== tab.content) {
            applyingExternalUpdateRef.current = true;
            view.dispatch({
                changes: {
                    from: 0,
                    to: currentContent.length,
                    insert: tab.content,
                },
            });
            applyingExternalUpdateRef.current = false;
        }
    }, [saveFile, tab]);

    useEffect(() => {
        if (!tab) {
            return;
        }

        if (!lastSavedContentByPathRef.current.has(tab.relativePath)) {
            lastSavedContentByPathRef.current.set(
                tab.relativePath,
                tab.content,
            );
        }
    }, [tab, tab?.content, tab?.relativePath]);

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
                currentTab ? [currentTab.path, currentTab.relativePath] : [],
                useChatStore.getState().sessionsById,
                { mode: "source" },
            );
        };

        syncMerge();
        const unsub = useChatStore.subscribe((state) => {
            const currentTab = tabRef.current;
            syncMergeViewForPaths(
                viewRef.current,
                currentTab ? [currentTab.path, currentTab.relativePath] : [],
                state.sessionsById,
                { mode: "source" },
            );
        });
        return unsub;
    }, []);

    useEffect(() => {
        const currentTab = tabRef.current;
        syncMergeViewForPaths(
            viewRef.current,
            currentTab ? [currentTab.path, currentTab.relativePath] : [],
            useChatStore.getState().sessionsById,
            { mode: "source" },
        );
    }, [tab, trackedFileMatch?.trackedFile.version]);

    useEffect(() => {
        queueMicrotask(() => setEditorContextMenu(null));
    }, [tab?.id]);

    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            if (tab) {
                const currentTab = useEditorStore
                    .getState()
                    .tabs.find(
                        (candidate): candidate is FileTab =>
                            candidate.id === tab.id && isFileTab(candidate),
                    );
                void saveFile(
                    currentTab ?? tab,
                    currentTab?.content ?? tab.content,
                );
            }
        };
    }, [saveFile, tab]);

    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            contextMenuCleanupRef.current?.();
            contextMenuCleanupRef.current = null;
            loadRequestRef.current += 1;
            viewRef.current?.destroy();
            viewRef.current = null;
            setEditorContextMenu(null);
            setEditorView(null);
        };
    }, []);

    const editorShellStyle = {
        "--editor-font-size": `${editorFontSize}px`,
        "--editor-font-family": getEditorFontFamily(editorFontFamily),
        "--text-input-line-height": String(editorLineHeight / 100),
        "--editor-content-width": `${editorContentWidth}px`,
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
            <div
                className="flex items-center justify-between gap-2 px-3 py-2"
                style={{
                    borderBottom: "1px solid var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                }}
            >
                <div className="min-w-0">
                    <div
                        className="text-[13px] font-medium truncate leading-tight"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {tab.title}
                    </div>
                    <div
                        className="text-[11px] truncate leading-tight"
                        style={{ color: "var(--text-secondary)" }}
                        title={tab.relativePath}
                    >
                        {tab.relativePath}
                    </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <button
                        type="button"
                        onClick={() => void openPath(tab.path)}
                        className="rounded-md px-2 py-1 text-[11px]"
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
                        className="rounded-md px-2 py-1 text-[11px]"
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

function getActiveFileTab(state: ReturnType<typeof useEditorStore.getState>) {
    const current = state.tabs.find(
        (candidate) => candidate.id === state.activeTabId,
    );
    return current && isFileTab(current) && current.viewer === "text"
        ? current
        : null;
}
