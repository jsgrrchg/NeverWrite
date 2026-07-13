import { useEffect, useRef, type ReactNode } from "react";

interface ChatFindBarProps {
    query: string;
    caseSensitive: boolean;
    total: number;
    activeIndex: number; // -1 when no matches
    onQueryChange: (value: string) => void;
    onToggleCaseSensitive: () => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
}

function counterLabel(query: string, total: number, activeIndex: number): string {
    if (!query) return "";
    if (total === 0) return "No results";
    return `${activeIndex + 1}/${total}`;
}

function FindIconButton({
    ariaLabel,
    title,
    onClick,
    disabled = false,
    children,
}: {
    ariaLabel: string;
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            title={title}
            className="nw-control-trigger flex h-[26px] w-[26px] items-center justify-center rounded-md"
            style={{
                color: "var(--text-secondary)",
                border: "none",
                backgroundColor: "transparent",
                opacity: disabled ? 0.4 : 1,
            }}
        >
            <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                {children}
            </svg>
        </button>
    );
}

export function ChatFindBar({
    query,
    caseSensitive,
    total,
    activeIndex,
    onQueryChange,
    onToggleCaseSensitive,
    onNext,
    onPrev,
    onClose,
}: ChatFindBarProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.select();
    }, []);

    const disabled = total === 0;

    return (
        <div
            role="search"
            aria-label="Find in chat"
            className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-[10px] px-1.5 py-1"
            style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            }}
            onKeyDown={(event) => {
                // Keep find shortcuts local to the bar.
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose();
                }
            }}
        >
            <input
                ref={inputRef}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        if (event.shiftKey) onPrev();
                        else onNext();
                    }
                }}
                placeholder="Find in chat…"
                aria-label="Find in chat"
                spellCheck={false}
                className="h-[22px] min-w-0 rounded px-2 outline-none"
                style={{
                    width: 168,
                    fontSize: 11,
                    lineHeight: "20px",
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-secondary) 60%, var(--bg-primary))",
                    color: "var(--text-primary)",
                    border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                }}
            />

            <span
                aria-live="polite"
                className="min-w-[44px] shrink-0 text-center text-[11px] tabular-nums"
                style={{ color: "var(--text-secondary)" }}
            >
                {counterLabel(query, total, activeIndex)}
            </span>

            <button
                type="button"
                onClick={onToggleCaseSensitive}
                aria-label="Match case"
                aria-pressed={caseSensitive}
                title="Match case"
                className="nw-control-trigger flex h-[26px] w-[26px] items-center justify-center rounded-md text-[11px] font-semibold"
                style={{
                    color: caseSensitive
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                    border: "none",
                    backgroundColor: "transparent",
                }}
            >
                Aa
            </button>

            <FindIconButton
                onClick={onPrev}
                disabled={disabled}
                ariaLabel="Previous match"
                title="Previous match (Shift+Enter)"
            >
                <path d="M3 9L7 5L11 9" />
            </FindIconButton>

            <FindIconButton
                onClick={onNext}
                disabled={disabled}
                ariaLabel="Next match"
                title="Next match (Enter)"
            >
                <path d="M3 5L7 9L11 5" />
            </FindIconButton>

            <FindIconButton
                onClick={onClose}
                ariaLabel="Close find"
                title="Close (Esc)"
            >
                <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
            </FindIconButton>
        </div>
    );
}
