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
import {
    useEditorStore,
    isFileTab,
    type FileTab,
} from "../../app/store/editorStore";
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
import { useChatStore } from "../ai/store/chatStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { loadCodeLanguage } from "./codeLanguage";
import { searchTheme } from "./extensions/searchTheme";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";
import { resolveEditorTargetForOpenTab } from "./editorTargetResolver";
import { subscribeEditorReviewSync } from "./editorReviewSync";
import { shouldEnableInlineReviewMergeView } from "./editorReviewGate";

type SavedVaultFileDetail = {
    relative_path: string;
    file_name: string;
    content: string;
};

type FileReloadMetadata = {
    origin?: "user" | "agent" | "external" | "system" | "unknown";
    opId?: string | null;
    revision?: number;
    contentHash?: string | null;
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
    const previousTabRef = useRef<FileTab | null>(null);
    const contextMenuCleanupRef = useRef<(() => void) | null>(null);
    const applyingExternalUpdateRef = useRef(false);
    const lastSavedContentByPathRef = useRef(new Map<string, string>());
    const lastAckRevisionByPathRef = useRef(new Map<string, number>());
    const pendingLocalOpIdByPathRef = useRef(new Map<string, string>());
    const saveRequestIdByPathRef = useRef(new Map<string, number>());
    const [, setEditorView] = useState<EditorView | null>(null);
    const [editorContextMenu, setEditorContextMenu] =
        useState<ContextMenuState<{ hasSelection: boolean }> | null>(null);

    const tab = useEditorStore((state) => {
        return getActiveFileTab(state);
    });
    const hasExternalConflict = useEditorStore((state) => {
        const relativePath = tab?.relativePath;
        return relativePath
            ? state.fileExternalConflicts.has(relativePath)
            : false;
    });
    const isDark = useThemeStore((s) => s.isDark);
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const editorFontFamily = useSettingsStore((s) => s.editorFontFamily);
    const editorLineHeight = useSettingsStore((s) => s.editorLineHeight);
    const editorContentWidth = useSettingsStore((s) => s.editorContentWidth);
    const lineWrapping = useSettingsStore((s) => s.lineWrapping);
    const inlineReviewEnabled = useSettingsStore((s) => s.inlineReviewEnabled);
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const sessionsById = useChatStore((state) => state.sessionsById);
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

    useEffect(() => {
        tabRef.current = tab;
    }, [tab]);

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

            const { editorFontSize, setSetting } = useSettingsStore.getState();

            if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                setSetting("editorFontSize", Math.min(24, editorFontSize + 1));
                return;
            }

            if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                setSetting("editorFontSize", Math.max(10, editorFontSize - 1));
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

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

    const syncCurrentSelection = useCallback((view: EditorView) => {
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
            const localOpId =
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `local-file-save-${Date.now()}-${Math.random()}`;
            pendingLocalOpIdByPathRef.current.set(
                targetTab.relativePath,
                localOpId,
            );

            try {
                const detail = await vaultInvoke<SavedVaultFileDetail>(
                    "save_vault_file",
                    {
                        relativePath: targetTab.relativePath,
                        content,
                        opId: localOpId,
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
                store.updateFileHistoryTitle(
                    targetTab.id,
                    targetTab.relativePath,
                    detail.file_name,
                );
                store.clearFileExternalConflict(targetTab.relativePath);
            } catch (error) {
                pendingLocalOpIdByPathRef.current.delete(
                    targetTab.relativePath,
                );
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
        });
        applyingExternalUpdateRef.current = false;
    }, []);

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
                            key: "Mod-f",
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
                            key: "Mod-l",
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
        syncCurrentSelection,
        tab,
        trackedFileMatch?.trackedFile.diffBase,
    ]);

    useEffect(() => {
        const view = viewRef.current;
        const previousTab = previousTabRef.current;

        if (previousTab && view) {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }

            const previousContent = view.state.doc.toString();
            const previousLastSaved =
                lastSavedContentByPathRef.current.get(
                    previousTab.relativePath,
                ) ?? previousTab.content;
            if (previousContent !== previousLastSaved) {
                void saveFile(previousTab, previousContent);
            }
        }

        previousTabRef.current = tab;

        if (!tab || !view) {
            return;
        }

        replaceEditorDocument(tab.content);
        lastSavedContentByPathRef.current.set(tab.relativePath, tab.content);
        useEditorStore.getState().clearCurrentSelection();
    }, [replaceEditorDocument, saveFile, tab?.id, tab?.relativePath]);

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
    }, [tab?.content, tab?.relativePath]);

    useEffect(() => {
        const unsubscribe = useEditorStore.subscribe((state, prev) => {
            const view = viewRef.current;
            if (!view) return;

            const activeTabId = state.activeTabId;
            if (!activeTabId) return;

            const currentTab = state.tabs.find(
                (candidate) => candidate.id === activeTabId,
            );
            const previousTab = prev.tabs.find(
                (candidate) => candidate.id === activeTabId,
            );
            if (!currentTab || !previousTab) return;
            if (!isFileTab(currentTab) || !isFileTab(previousTab)) return;
            if (currentTab.viewer !== "text" || previousTab.viewer !== "text") {
                return;
            }

            if (currentTab.relativePath !== previousTab.relativePath) {
                return;
            }

            const relativePath = currentTab.relativePath;
            const reloadVersion =
                state._fileReloadVersions?.[relativePath] ?? 0;
            const previousReloadVersion =
                prev._fileReloadVersions?.[relativePath] ?? 0;
            const isForced =
                state._pendingForceFileReloads?.has(relativePath) ?? false;

            if (reloadVersion === previousReloadVersion && !isForced) {
                return;
            }

            const currentContent = view.state.doc.toString();
            const lastSaved =
                lastSavedContentByPathRef.current.get(relativePath) ?? null;
            const hasLocalUnsavedChanges =
                lastSaved !== null && currentContent !== lastSaved;
            const incomingContent = currentTab.content;
            const reloadMeta = (state._fileReloadMetadata?.[relativePath] ??
                null) as FileReloadMetadata | null;
            const incomingOrigin = reloadMeta?.origin ?? "unknown";
            const incomingOpId = reloadMeta?.opId ?? null;
            const incomingRevision = reloadMeta?.revision ?? 0;
            const lastAckRevision =
                lastAckRevisionByPathRef.current.get(relativePath) ?? 0;
            const pendingLocalOpId =
                pendingLocalOpIdByPathRef.current.get(relativePath) ?? null;
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
            const acknowledgeIncomingRevision = () => {
                if (incomingRevision <= 0) return;
                lastAckRevisionByPathRef.current.set(
                    relativePath,
                    Math.max(lastAckRevision, incomingRevision),
                );
            };
            const clearPendingLocalAck = () => {
                if (isPendingLocalSaveAck) {
                    pendingLocalOpIdByPathRef.current.delete(relativePath);
                }
            };

            if (isStaleRevision) {
                clearPendingLocalAck();
                return;
            }

            if (!isForced && incomingContent === currentContent) {
                acknowledgeIncomingRevision();
                clearPendingLocalAck();
                if (lastSaved !== incomingContent) {
                    lastSavedContentByPathRef.current.set(
                        relativePath,
                        incomingContent,
                    );
                }
                useEditorStore
                    .getState()
                    .clearFileExternalConflict(relativePath);
                return;
            }

            if (hasLocalUnsavedChanges && !isForced) {
                if (isPendingLocalSaveAck) {
                    acknowledgeIncomingRevision();
                    clearPendingLocalAck();
                    lastSavedContentByPathRef.current.set(
                        relativePath,
                        incomingContent,
                    );
                    useEditorStore
                        .getState()
                        .clearFileExternalConflict(relativePath);
                    return;
                }
                useEditorStore
                    .getState()
                    .markFileExternalConflict(relativePath);
                return;
            }

            if (isForced) {
                useEditorStore.getState().clearForceFileReload(relativePath);
            }
            acknowledgeIncomingRevision();
            clearPendingLocalAck();
            useEditorStore.getState().clearFileExternalConflict(relativePath);
            lastSavedContentByPathRef.current.set(
                relativePath,
                incomingContent,
            );
            replaceEditorDocument(incomingContent);
        });

        return unsubscribe;
    }, [replaceEditorDocument]);

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
    }, [inlineReviewEnabled]);

    useEffect(() => {
        return subscribeEditorReviewSync(() =>
            resolveEditorTargetForOpenTab(tabRef.current),
        );
    }, [tab?.id, tab?.path, tab?.relativePath]);

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
    }, [inlineReviewEnabled, tab, trackedFileMatch?.trackedFile.version]);

    useEffect(() => {
        queueMicrotask(() => setEditorContextMenu(null));
        useEditorStore.getState().clearCurrentSelection();
    }, [tab?.id]);

    useEffect(() => {
        return () => {
            const currentTab = tabRef.current;
            const view = viewRef.current;
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            if (currentTab && view) {
                void saveFile(currentTab, view.state.doc.toString());
            }
            contextMenuCleanupRef.current?.();
            contextMenuCleanupRef.current = null;
            loadRequestRef.current += 1;
            useEditorStore.getState().clearCurrentSelection();
            viewRef.current?.destroy();
            viewRef.current = null;
            setEditorContextMenu(null);
            setEditorView(null);
        };
    }, [saveFile]);

    const editorShellStyle = {
        "--editor-font-size": `${editorFontSize}px`,
        "--editor-font-family": getEditorFontFamily(editorFontFamily),
        "--text-input-line-height": String(editorLineHeight / 100),
        "--editor-content-width": `${editorContentWidth}px`,
        "--editor-horizontal-inset": getEditorHorizontalInset(lineWrapping),
    } as CSSProperties;

    const reloadFileFromDisk = useCallback(async () => {
        if (!tab) return;

        try {
            const detail = await vaultInvoke<SavedVaultFileDetail>(
                "read_vault_file",
                {
                    relativePath: tab.relativePath,
                },
            );
            useEditorStore.getState().forceReloadFileContent(tab.relativePath, {
                title: detail.file_name,
                content: detail.content,
            });
            useEditorStore
                .getState()
                .clearFileExternalConflict(tab.relativePath);
        } catch (error) {
            console.error("Error reloading vault file:", error);
        }
    }, [tab]);

    const keepLocalFileVersion = useCallback(() => {
        if (!tab) return;
        useEditorStore.getState().clearFileExternalConflict(tab.relativePath);
    }, [tab]);

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
