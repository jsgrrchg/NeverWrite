import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@neverwrite/runtime";
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
import { useSettingsStore } from "../../app/store/settingsStore";
import { useThemeStore } from "../../app/store/themeStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { logError } from "../../app/utils/runtimeLog";
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
        black: theme.black,
        red: theme.red,
        green: theme.green,
        yellow: theme.yellow,
        blue: theme.blue,
        magenta: theme.magenta,
        cyan: theme.cyan,
        white: theme.white,
        brightBlack: theme.brightBlack,
        brightRed: theme.brightRed,
        brightGreen: theme.brightGreen,
        brightYellow: theme.brightYellow,
        brightBlue: theme.brightBlue,
        brightMagenta: theme.brightMagenta,
        brightCyan: theme.brightCyan,
        brightWhite: theme.brightWhite,
        selectionBackground: theme.selectionBackground,
        scrollbarSliderBackground: theme.scrollbarSliderBackground,
        scrollbarSliderHoverBackground: theme.scrollbarSliderHoverBackground,
        scrollbarSliderActiveBackground: theme.scrollbarSliderActiveBackground,
    };
}

function buildSearchSummary(resultIndex: number, resultCount: number) {
    if (resultCount <= 0) {
        return "No matches";
    }

    return `${Math.max(resultIndex + 1, 1)} / ${resultCount}`;
}

const TERMINAL_RESIZE_SETTLE_MS = 80;
// Flow-control watermarks for xterm.js write queue.
// When pending chars exceed HIGH, new chunks are queued locally.
// When pending drops below LOW, the local queue is drained.
const WRITE_HIGH_WATERMARK = 256_000;
const WRITE_LOW_WATERMARK = 64_000;

export function TerminalViewport({
    active = true,
    autoFocus = false,
    initialScrollPosition = "bottom",
    session,
}: {
    active?: boolean;
    autoFocus?: boolean;
    initialScrollPosition?: "top" | "bottom";
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
    const syncSizeRef = useRef<() => void>(() => undefined);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(
        null,
    );
    const lastRequestedSizeRef = useRef<{ cols: number; rows: number } | null>(
        null,
    );
    const lastSessionIdRef = useRef<string | null>(null);
    const lastRawOutputRef = useRef("");
    const lastRestoredFocusSessionIdRef = useRef<string | null>(null);
    const shouldApplyInitialScrollRef = useRef(false);
    const shouldRestoreFocusRef = useRef(false);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const pendingWriteCharsRef = useRef(0);
    const writeBacklogRef = useRef<string[]>([]);
    // Set to true after an explicit Shift+Enter write so that onData can drop
    // the duplicate \n that Electron's textarea sometimes leaks despite
    // event.preventDefault() — the root cause of ghost rows when lines added
    // via Shift+Enter are then deleted.
    const suppressNextNewlineRef = useRef(false);
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
    // Track right panel state so we can re-fit when it opens/closes/peeks.
    // The peek overlay is position:absolute and doesn't trigger ResizeObserver.
    const rightPanelKey = useLayoutStore(
        (s) => `${s.rightPanelCollapsed}:${s.rightPanelWidth}`,
    );
    const terminalFontFamily = useSettingsStore(
        (state) => state.terminalFontFamily,
    );
    const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
    const theme = getTerminalTheme(null, {
        fontFamily: terminalFontFamily,
        fontSize: terminalFontSize,
    });

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
        const lastRequestedSize = lastRequestedSizeRef.current;
        if (
            lastRequestedSize &&
            lastRequestedSize.cols === snapshot.cols &&
            lastRequestedSize.rows === snapshot.rows
        ) {
            lastRequestedSizeRef.current = null;
        }
    }, [snapshot.cols, snapshot.rows]);

    useEffect(() => {
        searchOpenRef.current = searchOpen;
    }, [searchOpen]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const terminal = new Terminal({
            allowTransparency: false,
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
            const queuedSize =
                pendingResizeRef.current ?? lastRequestedSizeRef.current;
            if (
                nextCols > 0 &&
                nextRows > 0 &&
                (nextCols !== currentSnapshot.cols ||
                    nextRows !== currentSnapshot.rows)
            ) {
                if (
                    queuedSize &&
                    queuedSize.cols === nextCols &&
                    queuedSize.rows === nextRows
                ) {
                    return;
                }

                // First fit after mount: send immediately so the PTY has the
                // correct size before Claude Code renders its initial frame.
                // Subsequent resizes (pane drags, etc.) still debounce to
                // avoid thrashing the PTY on every intermediate pixel.
                if (!lastRequestedSizeRef.current) {
                    if (resizeTimerRef.current) {
                        clearTimeout(resizeTimerRef.current);
                        resizeTimerRef.current = null;
                    }
                    pendingResizeRef.current = null;
                    lastRequestedSizeRef.current = {
                        cols: nextCols,
                        rows: nextRows,
                    };
                    void resizeRef
                        .current(nextCols, nextRows)
                        .catch(() => undefined);
                    return;
                }

                pendingResizeRef.current = { cols: nextCols, rows: nextRows };
                if (resizeTimerRef.current) {
                    clearTimeout(resizeTimerRef.current);
                }
                resizeTimerRef.current = setTimeout(() => {
                    const pendingResize = pendingResizeRef.current;
                    resizeTimerRef.current = null;
                    if (!pendingResize) {
                        return;
                    }

                    pendingResizeRef.current = null;
                    lastRequestedSizeRef.current = pendingResize;
                    void resizeRef
                        .current(pendingResize.cols, pendingResize.rows)
                        .catch(() => undefined);
                }, TERMINAL_RESIZE_SETTLE_MS);
            }
        };
        syncSizeRef.current = syncSize;

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
            if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                suppressNextNewlineRef.current = true;
                void writeInputRef.current("\n").catch(() => undefined);
                return false;
            }
            return true;
        });
        let cancelled = false;
        let onDataDisposable: ReturnType<typeof terminal.onData> | null = null;
        let onSelectionDisposable: ReturnType<
            typeof terminal.onSelectionChange
        > | null = null;
        let onSearchResultsDisposable: ReturnType<
            typeof searchAddon.onDidChangeResults
        > | null = null;
        let textarea: HTMLTextAreaElement | null = null;
        let handleFocus: (() => void) | null = null;
        let handleBlur: ((event: FocusEvent) => void) | null = null;
        let observer: ResizeObserver | null = null;

        const finishOpen = () => {
            if (cancelled) return;

            terminal.open(host);

            // WebGL renderer — fastest path. Falls back to DOM renderer on context
            // loss (GPU crash, system sleep, monitor switch).
            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => {
                    webglAddon.dispose();
                    webglAddonRef.current = null;
                });
                terminal.loadAddon(webglAddon);
                webglAddonRef.current = webglAddon;
            } catch (error) {
                logError(
                    "terminal",
                    "WebGL renderer unavailable — falling back to DOM renderer",
                    error,
                );
            }

            terminalRef.current = terminal;
            fitAddonRef.current = fitAddon;
            searchAddonRef.current = searchAddon;

            onDataDisposable = terminal.onData((data) => {
                if (data === "\n" && suppressNextNewlineRef.current) {
                    suppressNextNewlineRef.current = false;
                    return;
                }
                suppressNextNewlineRef.current = false;
                void writeInputRef
                    .current(data)
                    .catch((error) =>
                        console.error("[terminal] writeInput error:", error),
                    );
            });
            onSelectionDisposable =
                terminal.onSelectionChange(syncSelection);
            onSearchResultsDisposable = searchAddon.onDidChangeResults(
                (event) => {
                    setSearchResultIndex(event.resultIndex);
                    setSearchResultCount(event.resultCount);
                },
            );

            textarea = terminal.textarea ?? null;
            handleFocus = () => {
                shouldRestoreFocusRef.current = true;
                setFocused(true);
            };
            handleBlur = (event: FocusEvent) => {
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
            observer = new ResizeObserver(syncSize);
            observer.observe(host);
        };

        const fontFamily = theme.fontFamily.trim();
        // Only await font loading for custom fonts (fallback stack is always available).
        const isCustomFont =
            fontFamily.length > 0 &&
            !fontFamily.startsWith('"SFMono-Regular"');
        if (isCustomFont) {
            const spec = `${theme.fontSize}px "${fontFamily.split(",")[0].trim().replace(/^"|"$/g, "")}"`;
            Promise.all([
                document.fonts.load(spec),
                document.fonts.load(`bold ${spec}`),
            ])
                .catch(() => undefined)
                .then(finishOpen);
        } else {
            finishOpen();
        }

        return () => {
            cancelled = true;
            observer?.disconnect();
            onSearchResultsDisposable?.dispose();
            onSelectionDisposable?.dispose();
            if (textarea && handleBlur)
                textarea.removeEventListener("blur", handleBlur);
            if (textarea && handleFocus)
                textarea.removeEventListener("focus", handleFocus);
            onDataDisposable?.dispose();
            webglAddonRef.current?.dispose();
            webglAddonRef.current = null;
            pendingWriteCharsRef.current = 0;
            writeBacklogRef.current = [];
            terminal.dispose();
            syncSizeRef.current = () => undefined;
            terminalRef.current = null;
            fitAddonRef.current = null;
            searchAddonRef.current = null;
            if (resizeTimerRef.current) {
                clearTimeout(resizeTimerRef.current);
                resizeTimerRef.current = null;
            }
            pendingResizeRef.current = null;
            lastRequestedSizeRef.current = null;
            lastSessionIdRef.current = null;
            lastRawOutputRef.current = "";
            lastRestoredFocusSessionIdRef.current = null;
            shouldApplyInitialScrollRef.current = false;
            shouldRestoreFocusRef.current = false;
            setHasSelection(false);
            setFocused(false);
            setSearchOpen(false);
            setSearchQuery("");
            setSearchResultIndex(-1);
            setSearchResultCount(0);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closeSearch, openSearch]);

    useEffect(() => {
        if (!active) return;

        const frame = requestAnimationFrame(() => {
            syncSizeRef.current();
            if (autoFocus) {
                focusTerminal();
            }
        });

        return () => cancelAnimationFrame(frame);
    }, [active, autoFocus, focusTerminal, snapshot.sessionId]);

    // Re-fit after right panel open/close/peek. The peek overlay is
    // position:absolute so it doesn't trigger the ResizeObserver on the
    // terminal host. We wait 210ms to let the 190ms CSS transition finish.
    useEffect(() => {
        const timer = setTimeout(() => syncSizeRef.current(), 210);
        return () => clearTimeout(timer);
    }, [rightPanelKey]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        terminal.options.fontFamily = theme.fontFamily;
        terminal.options.fontSize = theme.fontSize;
        terminal.options.lineHeight = theme.lineHeight;
        terminal.options.theme = createXtermTheme(theme);
        fitAddonRef.current?.fit();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(theme)]);

    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        // Drain the local write backlog, capped at WRITE_LOW_WATERMARK chars per
        // iteration so xterm can interleave rendering between flushes.
        const flushBacklog = () => {
            const t = terminalRef.current;
            if (!t || writeBacklogRef.current.length === 0) return;
            if (pendingWriteCharsRef.current > WRITE_LOW_WATERMARK) return;
            let merged = "";
            while (
                writeBacklogRef.current.length > 0 &&
                merged.length < WRITE_LOW_WATERMARK
            ) {
                merged += writeBacklogRef.current.shift()!;
            }
            const chars = merged.length;
            pendingWriteCharsRef.current += chars;
            t.write(merged, () => {
                pendingWriteCharsRef.current = Math.max(
                    0,
                    pendingWriteCharsRef.current - chars,
                );
                queueMicrotask(flushBacklog);
            });
        };

        // Write a chunk to xterm, queueing locally if the write buffer is full.
        const writeChunk = (data: string, onDone?: () => void) => {
            if (pendingWriteCharsRef.current > WRITE_HIGH_WATERMARK) {
                writeBacklogRef.current.push(data);
                return;
            }
            const chars = data.length;
            pendingWriteCharsRef.current += chars;
            terminal.write(data, () => {
                pendingWriteCharsRef.current = Math.max(
                    0,
                    pendingWriteCharsRef.current - chars,
                );
                onDone?.();
                queueMicrotask(flushBacklog);
            });
        };

        const sessionId = snapshot.sessionId || "__pending-terminal__";
        const previousSessionId = lastSessionIdRef.current;

        if (previousSessionId !== sessionId) {
            terminal.reset();
            pendingWriteCharsRef.current = 0;
            writeBacklogRef.current = [];
            lastSessionIdRef.current = sessionId;
            lastRawOutputRef.current = "";
            shouldApplyInitialScrollRef.current =
                initialScrollPosition === "top";
            queueMicrotask(() => {
                setHasSelection(false);
                setSearchResultCount(0);
                setSearchResultIndex(-1);
            });
        }

        if (rawOutput === lastRawOutputRef.current) {
            return;
        }

        if (
            rawOutput.length < lastRawOutputRef.current.length ||
            !rawOutput.startsWith(lastRawOutputRef.current)
        ) {
            // Check whether this is a truncation event rather than a genuine
            // content mismatch. appendTerminalRawOutput caps rawOutput at
            // MAX_RAW_OUTPUT_CHARS by slicing off the front; once the session
            // crosses that threshold every new chunk lands here, triggering
            // terminal.reset() on every write and causing continuous flicker.
            //
            // Truncation signature: rawOutput didn't shrink (it stayed at the
            // MAX cap), and rawOutput = lastRef[delta:] + newChunk. We recover
            // the new tail by locating the start of rawOutput inside lastRef
            // with a short probe, then writing only the new bytes.
            if (rawOutput.length >= lastRawOutputRef.current.length) {
                const PROBE_LEN = 32;
                // Search up to MAX_SEARCH chars into lastRef for the delta
                // offset. The inter-render delta can be large when the store
                // coalesces multiple PTY events (paste echo, large file cat,
                // TUI redraws) — 512KB covers most realistic bursts without
                // meaningful cost since String.indexOf is native.
                const MAX_SEARCH = 512_000;
                const probe = rawOutput.slice(0, PROBE_LEN);
                const searchArea = lastRawOutputRef.current.slice(
                    1,
                    MAX_SEARCH + PROBE_LEN,
                );
                const hit = searchArea.indexOf(probe);
                if (hit >= 0) {
                    const delta = hit + 1; // +1 because searchArea starts at 1
                    // Verify the match extends well past the probe to reduce
                    // (not eliminate) false positives from repeated ANSI
                    // sequences — TUI spinners and redraws can emit long runs
                    // of identical escape codes. A wrong delta produces one
                    // garbled frame before the next reset corrects it.
                    if (
                        lastRawOutputRef.current.slice(
                            delta + PROBE_LEN,
                            delta + PROBE_LEN * 2,
                        ) === rawOutput.slice(PROBE_LEN, PROBE_LEN * 2)
                    ) {
                        const overlapLen =
                            lastRawOutputRef.current.length - delta;
                        const newChunk =
                            overlapLen < rawOutput.length
                                ? rawOutput.slice(overlapLen)
                                : "";
                        if (newChunk.length > 0) {
                            writeChunk(newChunk, () => {
                                if (!shouldApplyInitialScrollRef.current)
                                    return;
                                shouldApplyInitialScrollRef.current = false;
                                terminal.scrollToTop();
                            });
                        }
                        lastRawOutputRef.current = rawOutput;
                        return;
                    }
                }
                // Probe not found or verification failed — fall through to
                // full reset (genuine mismatch or enormous chunk > MAX_SEARCH).
            }
            terminal.reset();
            pendingWriteCharsRef.current = 0;
            writeBacklogRef.current = [];
            if (rawOutput.length > 0) {
                writeChunk(rawOutput, () => {
                    if (!shouldApplyInitialScrollRef.current) return;
                    shouldApplyInitialScrollRef.current = false;
                    terminal.scrollToTop();
                });
            } else {
                shouldApplyInitialScrollRef.current = false;
            }
            lastRawOutputRef.current = rawOutput;
            return;
        }

        const nextChunk = rawOutput.slice(lastRawOutputRef.current.length);
        if (nextChunk.length > 0) {
            writeChunk(nextChunk, () => {
                if (!shouldApplyInitialScrollRef.current) return;
                shouldApplyInitialScrollRef.current = false;
                terminal.scrollToTop();
            });
        }
        lastRawOutputRef.current = rawOutput;
    }, [initialScrollPosition, rawOutput, snapshot.sessionId]);

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

        queueMicrotask(() => runSearch("next"));
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
                paddingBottom: 8,
            }}
            onMouseDown={handleMouseDown}
            onContextMenu={handleContextMenu}
        >
            <div
                ref={hostRef}
                className="terminal-surface h-full min-h-0"
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
