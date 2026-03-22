import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent,
} from "react";
import { useThemeStore } from "../../../app/store/themeStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import { getTerminalTheme } from "./terminalTheme";
import type { TerminalSessionView } from "./terminalTypes";

function TerminalMessage({ message }: { message: string }) {
    return (
        <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            style={{ color: "var(--text-secondary)" }}
        >
            <span className="text-xs">{message}</span>
        </div>
    );
}

function createXtermTheme(theme: ReturnType<typeof getTerminalTheme>) {
    return {
        background: theme.background,
        cursor: theme.cursor,
        cursorAccent: theme.background,
        foreground: theme.text,
        selectionBackground: "rgba(120, 138, 158, 0.28)",
    };
}

function buildSearchSummary(resultIndex: number, resultCount: number) {
    if (resultCount <= 0) {
        return "No matches";
    }

    return `${Math.max(resultIndex + 1, 1)} / ${resultCount}`;
}

export function TerminalViewport({
    session,
}: {
    session: TerminalSessionView;
}) {
    const { rawOutput, resize, snapshot, writeInput } = session;
    const hostRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const writeInputRef = useRef(writeInput);
    const resizeRef = useRef(resize);
    const snapshotRef = useRef(snapshot);
    const lastSessionIdRef = useRef<string | null>(null);
    const lastRawOutputRef = useRef("");
    const lastRestoredFocusSessionIdRef = useRef<string | null>(null);
    const shouldRestoreFocusRef = useRef(false);
    const searchPanelRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchOpenRef = useRef(false);
    const searchInputId = useId();
    const [focused, setFocused] = useState(false);
    const [hasSelection, setHasSelection] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchResultIndex, setSearchResultIndex] = useState(-1);
    const [searchResultCount, setSearchResultCount] = useState(0);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<void> | null>(null);

    useThemeStore((state) => `${state.themeName}:${state.isDark}`);
    const theme = getTerminalTheme(null);

    const focusTerminal = useCallback(() => {
        shouldRestoreFocusRef.current = true;
        terminalRef.current?.focus();
    }, []);

    const closeSearch = useCallback(() => {
        setSearchOpen(false);
        searchAddonRef.current?.clearDecorations();
        requestAnimationFrame(() => {
            focusTerminal();
        });
    }, [focusTerminal]);

    const runSearch = useCallback(
        (direction: "next" | "previous", queryOverride?: string) => {
            const searchAddon = searchAddonRef.current;
            if (!searchAddon) {
                return false;
            }

            const query = queryOverride ?? searchQuery;
            if (!query) {
                searchAddon.clearDecorations();
                setSearchResultCount(0);
                setSearchResultIndex(-1);
                return false;
            }

            const options = {
                caseSensitive: searchCaseSensitive,
                incremental: direction === "next",
            };

            return direction === "previous"
                ? searchAddon.findPrevious(query, options)
                : searchAddon.findNext(query, options);
        },
        [searchCaseSensitive, searchQuery],
    );

    const openSearch = useCallback(() => {
        setSearchOpen(true);
        requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        });
    }, []);

    useEffect(() => {
        writeInputRef.current = writeInput;
        resizeRef.current = resize;
        snapshotRef.current = snapshot;
    }, [resize, snapshot, writeInput]);

    useEffect(() => {
        searchOpenRef.current = searchOpen;
    }, [searchOpen]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const terminal = new Terminal({
            allowTransparency: true,
            convertEol: false,
            cursorBlink: true,
            cursorStyle: "block",
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize,
            lineHeight: theme.lineHeight,
            macOptionIsMeta: true,
            rightClickSelectsWord: true,
            scrollback: 20_000,
            theme: createXtermTheme(theme),
        });
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        const webLinksAddon = new WebLinksAddon((event, uri) => {
            event.preventDefault();
            void openUrl(uri);
        });
        const syncSelection = () =>
            setHasSelection(terminal.getSelection().length > 0);
        const syncSize = () => {
            fitAddon.fit();
            const nextCols = terminal.cols;
            const nextRows = terminal.rows;
            const currentSnapshot = snapshotRef.current;
            if (
                nextCols > 0 &&
                nextRows > 0 &&
                (nextCols !== currentSnapshot.cols ||
                    nextRows !== currentSnapshot.rows)
            ) {
                void resizeRef
                    .current(nextCols, nextRows)
                    .catch(() => undefined);
            }
        };

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(webLinksAddon);
        terminal.attachCustomKeyEventHandler((event) => {
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && key === "f") {
                event.preventDefault();
                openSearch();
                return false;
            }
            if (searchOpenRef.current && event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return false;
            }
            return true;
        });
        terminal.open(host);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        searchAddonRef.current = searchAddon;

        const onDataDisposable = terminal.onData((data) => {
            void writeInputRef
                .current(data)
                .catch((error) =>
                    console.error("[terminal] writeInput error:", error),
                );
        });
        const onSelectionDisposable = terminal.onSelectionChange(syncSelection);
        const onSearchResultsDisposable = searchAddon.onDidChangeResults(
            (event) => {
                setSearchResultIndex(event.resultIndex);
                setSearchResultCount(event.resultCount);
            },
        );
        const textarea = terminal.textarea;
        const handleFocus = () => {
            shouldRestoreFocusRef.current = true;
            setFocused(true);
        };
        const handleBlur = (event: FocusEvent) => {
            const nextTarget = event.relatedTarget;
            const nextInsideSearch =
                nextTarget instanceof Node &&
                searchPanelRef.current?.contains(nextTarget);

            if (!nextInsideSearch) {
                shouldRestoreFocusRef.current = false;
            }
            setFocused(false);
            searchAddon.clearActiveDecoration();
        };

        textarea?.addEventListener("focus", handleFocus);
        textarea?.addEventListener("blur", handleBlur);

        syncSize();

        const observer = new ResizeObserver(syncSize);
        observer.observe(host);

        return () => {
            observer.disconnect();
            onSearchResultsDisposable.dispose();
            onSelectionDisposable.dispose();
            textarea?.removeEventListener("blur", handleBlur);
            textarea?.removeEventListener("focus", handleFocus);
            onDataDisposable.dispose();
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            searchAddonRef.current = null;
            lastSessionIdRef.current = null;
            lastRawOutputRef.current = "";
            lastRestoredFocusSessionIdRef.current = null;
            shouldRestoreFocusRef.current = false;
            setHasSelection(false);
            setFocused(false);
            setSearchOpen(false);
            setSearchQuery("");
            setSearchResultIndex(-1);
            setSearchResultCount(0);
        };
    }, [closeSearch, openSearch]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        terminal.options.fontFamily = theme.fontFamily;
        terminal.options.fontSize = theme.fontSize;
        terminal.options.lineHeight = theme.lineHeight;
        terminal.options.theme = createXtermTheme(theme);
        fitAddonRef.current?.fit();
    }, [
        theme.background,
        theme.cursor,
        theme.fontFamily,
        theme.fontSize,
        theme.lineHeight,
        theme.text,
    ]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        const sessionId = snapshot.sessionId || "__pending-terminal__";
        const previousSessionId = lastSessionIdRef.current;

        if (previousSessionId !== sessionId) {
            terminal.reset();
            lastSessionIdRef.current = sessionId;
            lastRawOutputRef.current = "";
            setHasSelection(false);
            setSearchResultCount(0);
            setSearchResultIndex(-1);
        }

        if (rawOutput === lastRawOutputRef.current) {
            return;
        }

        if (
            rawOutput.length < lastRawOutputRef.current.length ||
            !rawOutput.startsWith(lastRawOutputRef.current)
        ) {
            terminal.reset();
            if (rawOutput.length > 0) {
                terminal.write(rawOutput);
            }
            lastRawOutputRef.current = rawOutput;
            return;
        }

        const nextChunk = rawOutput.slice(lastRawOutputRef.current.length);
        if (nextChunk.length > 0) {
            terminal.write(nextChunk);
        }
        lastRawOutputRef.current = rawOutput;
    }, [rawOutput, snapshot.sessionId]);

    useEffect(() => {
        if (
            snapshot.status !== "running" ||
            !snapshot.sessionId ||
            !shouldRestoreFocusRef.current
        ) {
            return;
        }

        if (lastRestoredFocusSessionIdRef.current === snapshot.sessionId) {
            return;
        }

        requestAnimationFrame(() => {
            terminalRef.current?.focus();
        });
        lastRestoredFocusSessionIdRef.current = snapshot.sessionId;
    }, [snapshot.sessionId, snapshot.status]);

    useEffect(() => {
        if (!searchOpen) {
            return;
        }
        requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        });
    }, [searchOpen]);

    useEffect(() => {
        if (!searchOpen || !searchQuery) {
            return;
        }

        runSearch("next");
    }, [runSearch, searchCaseSensitive, searchOpen, searchQuery]);

    const handleContextMenu = useCallback(
        (event: MouseEvent<HTMLDivElement>) => {
            event.preventDefault();
            focusTerminal();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: undefined as void,
            });
        },
        [focusTerminal],
    );

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    const handleMouseDown = useCallback(
        (event: MouseEvent<HTMLDivElement>) => {
            if (
                searchPanelRef.current &&
                searchPanelRef.current.contains(event.target as Node)
            ) {
                return;
            }
            focusTerminal();
        },
        [focusTerminal],
    );

    const handleSearchInputKeyDown = useCallback(
        (event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
            }
        },
        [closeSearch, runSearch],
    );

    const contextMenuEntries: ContextMenuEntry[] = [
        {
            label: "Copy",
            disabled: !hasSelection,
            action: () => {
                const text = terminalRef.current?.getSelection();
                if (text) {
                    void navigator.clipboard.writeText(text);
                }
            },
        },
        {
            label: "Paste",
            disabled: snapshot.status !== "running",
            action: () => {
                void navigator.clipboard.readText().then((text) => {
                    if (!text) return;
                    void writeInputRef.current(text).catch(() => undefined);
                });
            },
        },
        { type: "separator" },
        {
            label: "Select All",
            action: () => {
                terminalRef.current?.selectAll();
                setHasSelection(true);
            },
        },
        { type: "separator" },
        {
            label: "Find",
            action: () => openSearch(),
        },
        { type: "separator" },
        {
            label: "Clear",
            disabled: rawOutput.length === 0,
            action: () => session.clearViewport(),
        },
    ];

    const noOutput = rawOutput.length === 0;

    return (
        <div
            className="relative h-full min-h-0 overflow-hidden outline-none"
            style={{
                backgroundColor: theme.background,
                color: theme.text,
            }}
            onMouseDown={handleMouseDown}
            onContextMenu={handleContextMenu}
        >
            <div
                ref={hostRef}
                className="devtools-terminal-surface h-full min-h-0"
            />

            {searchOpen && (
                <div
                    ref={searchPanelRef}
                    className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border px-2 py-2 shadow-lg"
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-secondary) 92%, transparent)",
                        borderColor: "var(--border)",
                        color: "var(--text-primary)",
                    }}
                >
                    <label htmlFor={searchInputId} className="sr-only">
                        Find in terminal
                    </label>
                    <input
                        id={searchInputId}
                        ref={searchInputRef}
                        type="text"
                        value={searchQuery}
                        onChange={(event) => {
                            const nextQuery = event.target.value;
                            setSearchQuery(nextQuery);
                            void runSearch("next", nextQuery);
                        }}
                        onKeyDown={handleSearchInputKeyDown}
                        onBlur={() => {
                            searchAddonRef.current?.clearActiveDecoration();
                        }}
                        placeholder="Find in terminal"
                        className="h-8 w-52 rounded border px-2 text-xs outline-none"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            borderColor: "var(--border)",
                            color: "var(--text-primary)",
                        }}
                    />
                    <button
                        type="button"
                        onClick={() =>
                            setSearchCaseSensitive((current) => !current)
                        }
                        className="h-8 rounded border px-2 text-[11px]"
                        style={{
                            backgroundColor: searchCaseSensitive
                                ? "var(--accent)"
                                : "var(--bg-primary)",
                            borderColor: "var(--border)",
                            color: searchCaseSensitive
                                ? "white"
                                : "var(--text-secondary)",
                        }}
                        title="Match case"
                    >
                        Aa
                    </button>
                    <button
                        type="button"
                        onClick={() => runSearch("previous")}
                        className="h-8 rounded border px-2 text-xs"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            borderColor: "var(--border)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Prev
                    </button>
                    <button
                        type="button"
                        onClick={() => runSearch("next")}
                        className="h-8 rounded border px-2 text-xs"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            borderColor: "var(--border)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Next
                    </button>
                    <span
                        className="min-w-16 text-right text-[11px]"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {buildSearchSummary(
                            searchResultIndex,
                            searchResultCount,
                        )}
                    </span>
                    <button
                        type="button"
                        onClick={closeSearch}
                        className="h-8 rounded border px-2 text-xs"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            borderColor: "var(--border)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Close
                    </button>
                </div>
            )}

            {snapshot.status === "starting" && noOutput && (
                <TerminalMessage message="Starting shell..." />
            )}
            {snapshot.status === "idle" && noOutput && (
                <TerminalMessage message="Shell not started" />
            )}
            {snapshot.status === "error" && noOutput && (
                <TerminalMessage
                    message={snapshot.errorMessage ?? "Shell unavailable"}
                />
            )}
            {snapshot.status === "exited" && noOutput && (
                <TerminalMessage message="Shell exited - restart to continue" />
            )}

            {!focused && snapshot.status === "running" && noOutput && (
                <div
                    className="pointer-events-none absolute bottom-3 right-3 rounded border px-2 py-1 text-[11px]"
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-secondary) 86%, transparent)",
                        borderColor: "var(--border)",
                        color: "var(--text-secondary)",
                    }}
                >
                    Click to focus terminal
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    entries={contextMenuEntries}
                    onClose={closeContextMenu}
                />
            )}
        </div>
    );
}
