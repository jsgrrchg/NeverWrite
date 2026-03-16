import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
    type MouseEvent,
} from "react";
import { useThemeStore } from "../../../app/store/themeStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import { getTerminalGridSize } from "./terminalSizing";
import { renderTerminalBufferWithCursor } from "./terminalBuffer";
import { translateTerminalKeyEvent } from "./terminalInput";
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

export function TerminalViewport({
    session,
}: {
    session: TerminalSessionView;
}) {
    const { bufferState, output, resize, snapshot, writeInput } = session;
    const viewportRef = useRef<HTMLDivElement>(null);
    const [focused, setFocused] = useState(false);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    useThemeStore((s) => `${s.themeName}:${s.isDark}`);
    const theme = getTerminalTheme(null);

    useLayoutEffect(() => {
        const element = viewportRef.current;
        if (!element) return;

        const syncSize = () => {
            const next = getTerminalGridSize(element);
            if (next.cols !== snapshot.cols || next.rows !== snapshot.rows) {
                void resize(next.cols, next.rows).catch(() => undefined);
            }
        };

        syncSize();

        const observer = new ResizeObserver(() => {
            syncSize();
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [resize, snapshot.cols, snapshot.rows]);

    useEffect(() => {
        const element = viewportRef.current;
        if (!element) return;
        element.scrollTop = element.scrollHeight;
    }, [output, snapshot.status]);

    // Auto-focus when the terminal becomes ready
    useEffect(() => {
        if (snapshot.status === "running" && viewportRef.current) {
            viewportRef.current.focus();
        }
    }, [snapshot.status]);

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const input = translateTerminalKeyEvent(event);
        if (!input) return;
        event.preventDefault();
        void writeInput(input).catch((err) =>
            console.error("[terminal] writeInput error:", err),
        );
    };

    const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        void writeInput(text).catch(() => undefined);
    };

    const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.focus();
    };

    const handleContextMenu = useCallback(
        (event: MouseEvent<HTMLDivElement>) => {
            event.preventDefault();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: undefined as void,
            });
        },
        [],
    );

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    const contextMenuEntries: ContextMenuEntry[] = [];

    const selection = window.getSelection();
    const hasSelection = selection !== null && selection.toString().length > 0;

    contextMenuEntries.push({
        label: "Copy",
        disabled: !hasSelection,
        action: () => {
            const text = window.getSelection()?.toString();
            if (text) void navigator.clipboard.writeText(text);
        },
    });

    contextMenuEntries.push({
        label: "Paste",
        disabled: snapshot.status !== "running",
        action: () => {
            void navigator.clipboard.readText().then((text) => {
                if (text) void writeInput(text).catch(() => undefined);
            });
        },
    });

    contextMenuEntries.push({ type: "separator" });

    contextMenuEntries.push({
        label: "Select All",
        action: () => {
            const pre = viewportRef.current?.querySelector("pre");
            if (!pre) return;
            const range = document.createRange();
            range.selectNodeContents(pre);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        },
    });

    contextMenuEntries.push({ type: "separator" });

    contextMenuEntries.push({
        label: "Clear",
        disabled: output.length === 0,
        action: () => session.clearViewport(),
    });

    const noOutput = output.length === 0;
    const rendered = renderTerminalBufferWithCursor(bufferState, snapshot.cols);
    const cursorText = rendered.cursor === " " ? "\u00a0" : rendered.cursor;

    return (
        <div
            ref={viewportRef}
            tabIndex={0}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onMouseDown={handleMouseDown}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onContextMenu={handleContextMenu}
            className="relative h-full min-h-0 overflow-auto px-3 py-2 outline-none"
            style={{
                backgroundColor: "var(--bg-primary)",
                color: theme.text,
                fontFamily: theme.fontFamily,
                fontSize: theme.fontSize,
                lineHeight: theme.lineHeight,
                userSelect: "text",
                WebkitUserSelect: "text",
            }}
            data-selectable="true"
        >
            <pre
                className="m-0 min-h-full"
                style={{
                    font: "inherit",
                    color: theme.text,
                    background: "transparent",
                    whiteSpace: "pre",
                }}
            >
                {snapshot.status === "running" ? (
                    <>
                        {rendered.before}
                        <span
                            aria-hidden="true"
                            style={{
                                display: "inline-block",
                                minWidth: "1ch",
                                height: 16,
                                transform: "translateY(2px)",
                                backgroundColor: focused
                                    ? theme.cursor
                                    : "color-mix(in srgb, var(--text-secondary) 35%, transparent)",
                                color: focused
                                    ? "var(--bg-primary)"
                                    : theme.text,
                                animation: focused
                                    ? "devtools-terminal-cursor 1s steps(2, start) infinite"
                                    : "none",
                            }}
                        >
                            {cursorText}
                        </span>
                        {rendered.after}
                    </>
                ) : (
                    output
                )}
            </pre>

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
                <TerminalMessage message="Shell exited — restart to continue" />
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
