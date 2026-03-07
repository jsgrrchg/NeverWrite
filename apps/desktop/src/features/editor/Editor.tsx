import { useEffect, useRef, useCallback } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
    syntaxHighlighting,
    defaultHighlightStyle,
} from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getWindowMode } from "../../app/detachedWindows";
import { useEditorStore, type Tab } from "../../app/store/editorStore";
import { useThemeStore } from "../../app/store/themeStore";

const AUTOSAVE_DELAY = 1000;
const appWindow = getCurrentWindow();

// Base theme using CSS variables — responds to dark/light via CSS class toggle
const baseTheme = EditorView.theme({
    "&": {
        height: "100%",
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        fontSize: "14px",
    },
    ".cm-scroller": {
        overflow: "auto",
        fontFamily: "inherit",
    },
    ".cm-content": {
        padding: "24px",
        maxWidth: "760px",
        margin: "0 auto",
        caretColor: "var(--text-primary)",
        lineHeight: "1.7",
    },
    ".cm-gutters": {
        display: "none",
    },
    ".cm-cursor": {
        borderLeftColor: "var(--text-primary)",
    },
    "&.cm-focused": {
        outline: "none",
    },
});

// Compartment for syntax highlighting (switches between dark/light)
const syntaxCompartment = new Compartment();

function getSyntaxExtension(isDark: boolean) {
    // Only switch syntax highlighting colors, not the full editor theme
    return isDark
        ? syntaxHighlighting(oneDarkHighlightStyle)
        : syntaxHighlighting(defaultHighlightStyle);
}

interface EditorProps {
    emptyStateMessage?: string;
}

export function Editor({
    emptyStateMessage = "Abre una nota del panel izquierdo",
}: EditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeTabRef = useRef<Tab | null>(null);
    const isInternalRef = useRef(false);
    // Save/restore full EditorState per tab (preserves undo history + scroll)
    const tabStatesRef = useRef<Map<string, EditorState>>(new Map());
    const prevTabIdRef = useRef<string | null>(null);

    const { tabs, activeTabId, updateTabContent, markTabClean } =
        useEditorStore();
    const { isDark } = useThemeStore();

    const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
    activeTabRef.current = activeTab;

    const saveNow = useCallback(
        async (tab: Tab, content: string) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            try {
                await invoke("save_note", { noteId: tab.noteId, content });
                markTabClean(tab.id);
            } catch (e) {
                console.error("Error al guardar nota:", e);
            }
        },
        [markTabClean],
    );

    const scheduleSave = useCallback(
        (tab: Tab, content: string) => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                saveNow(tab, content);
            }, AUTOSAVE_DELAY);
        },
        [saveNow],
    );

    // Factory to create a fresh EditorState with all extensions
    const createEditorState = useCallback(
        (doc: string) => {
            return EditorState.create({
                doc,
                extensions: [
                    history(),
                    EditorView.lineWrapping,
                    markdown(),
                    baseTheme,
                    syntaxCompartment.of(
                        getSyntaxExtension(useThemeStore.getState().isDark),
                    ),
                    keymap.of([
                        ...defaultKeymap,
                        ...historyKeymap,
                        {
                            key: "Mod-s",
                            run: () => {
                                const tab = activeTabRef.current;
                                if (tab) {
                                    const content =
                                        viewRef.current?.state.doc.toString() ??
                                        tab.content;
                                    saveNow(tab, content);
                                }
                                return true;
                            },
                        },
                    ]),
                    EditorView.updateListener.of((update) => {
                        if (!update.docChanged || isInternalRef.current) return;
                        const tab = activeTabRef.current;
                        if (!tab) return;
                        const content = update.state.doc.toString();
                        updateTabContent(tab.id, content);
                        scheduleSave(tab, content);
                    }),
                ],
            });
        },
        [saveNow, scheduleSave, updateTabContent],
    );

    // Initialize CodeMirror once — container is always in the DOM
    useEffect(() => {
        if (!containerRef.current) return;

        const view = new EditorView({
            state: createEditorState(activeTabRef.current?.content ?? ""),
            parent: containerRef.current,
        });
        viewRef.current = view;

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            view.destroy();
            viewRef.current = null;
        };
        // stable deps — createEditorState only depends on stable zustand refs
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Switch tabs: save previous state, restore or create new state
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        const prevId = prevTabIdRef.current;
        prevTabIdRef.current = activeTabId;

        // Cancel any pending autosave (prevents saving to wrong tab)
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }

        // Save previous tab's EditorState (preserves undo history + scroll)
        if (prevId && prevId !== activeTabId) {
            tabStatesRef.current.set(prevId, view.state);
        }

        if (!activeTabId || !activeTab) return;

        // Restore saved state or create fresh one
        const savedState = tabStatesRef.current.get(activeTabId);
        isInternalRef.current = true;
        if (savedState) {
            view.setState(savedState);
        } else {
            view.setState(createEditorState(activeTab.content));
        }
        isInternalRef.current = false;

        // Ensure syntax theme matches current dark/light mode
        view.dispatch({
            effects: syntaxCompartment.reconfigure(
                getSyntaxExtension(useThemeStore.getState().isDark),
            ),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabId]);

    // Reconfigure syntax theme when isDark changes
    useEffect(() => {
        viewRef.current?.dispatch({
            effects: syntaxCompartment.reconfigure(getSyntaxExtension(isDark)),
        });
    }, [isDark]);

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

    // Always render the container so CodeMirror initializes properly
    return (
        <div
            className="flex-1 overflow-hidden relative"
            style={{ height: "100%" }}
        >
            <div ref={containerRef} className="h-full" />
            {!activeTab && (
                <div
                    className="absolute inset-0 flex items-center justify-center text-sm"
                    style={{
                        color: "var(--text-secondary)",
                        backgroundColor: "var(--bg-primary)",
                    }}
                >
                    {emptyStateMessage}
                </div>
            )}
        </div>
    );
}
