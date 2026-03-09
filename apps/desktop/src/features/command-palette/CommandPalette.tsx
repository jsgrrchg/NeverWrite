import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useCommandStore, type Command } from "./store/commandStore";

export function CommandPalette() {
    const activeModal = useCommandStore((s) => s.activeModal);

    if (activeModal !== "command-palette") return null;

    return <CommandPaletteDialog />;
}

function CommandPaletteDialog() {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const search = useCommandStore((s) => s.search);
    const closeModal = useCommandStore((s) => s.closeModal);
    const results = useMemo(() => search(query), [query, search]);

    useEffect(() => {
        const frame = window.setTimeout(() => inputRef.current?.focus(), 0);
        return () => window.clearTimeout(frame);
    }, []);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const item = list.children[selectedIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const executeAndClose = useCallback(
        (cmd: Command) => {
            closeModal();
            // Defer execution so modal closes first
            requestAnimationFrame(() => cmd.execute());
        },
        [closeModal],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
                e.preventDefault();
                const cmd = results[selectedIndex];
                if (cmd) executeAndClose(cmd);
            } else if (e.key === "Escape") {
                e.preventDefault();
                closeModal();
            }
        },
        [results, selectedIndex, executeAndClose, closeModal],
    );

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center"
            style={{ paddingTop: "20vh" }}
            onClick={closeModal}
        >
            <div
                className="w-full max-w-md rounded-lg shadow-2xl overflow-hidden"
                style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setSelectedIndex(0);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a command..."
                    className="w-full px-4 py-3 text-sm outline-none"
                    style={{
                        backgroundColor: "transparent",
                        color: "var(--text-primary)",
                        borderBottom: "1px solid var(--border)",
                    }}
                />
                <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
                    {results.length === 0 ? (
                        <div
                            className="px-4 py-3 text-sm"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            No commands found
                        </div>
                    ) : (
                        results.map((cmd, i) => (
                            <button
                                key={cmd.id}
                                onClick={() => executeAndClose(cmd)}
                                className="w-full text-left px-4 py-2 flex items-center justify-between text-sm"
                                style={{
                                    backgroundColor:
                                        i === selectedIndex
                                            ? "var(--accent)"
                                            : "transparent",
                                    color:
                                        i === selectedIndex
                                            ? "#fff"
                                            : "var(--text-primary)",
                                }}
                            >
                                <span>
                                    <span
                                        className="text-xs mr-2"
                                        style={{
                                            opacity:
                                                i === selectedIndex ? 0.8 : 0.5,
                                        }}
                                    >
                                        {cmd.category}
                                    </span>
                                    {cmd.label}
                                </span>
                                {cmd.shortcut && (
                                    <span
                                        className="text-xs font-mono"
                                        style={{
                                            opacity:
                                                i === selectedIndex ? 0.8 : 0.5,
                                        }}
                                    >
                                        {cmd.shortcut}
                                    </span>
                                )}
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
