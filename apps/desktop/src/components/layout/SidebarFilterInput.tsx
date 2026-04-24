import { useRef, type KeyboardEvent } from "react";

// Persistent filter input rendered at the top of each sidebar panel. Styled
// after Comando's `.sidebar-search`: translucent pill, leading search icon,
// inline clear button, Escape clears. Filtering itself is the caller's job.

export interface SidebarFilterInputProps {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    ariaLabel?: string;
}

export function SidebarFilterInput({
    value,
    onChange,
    placeholder = "Filter...",
    ariaLabel,
}: SidebarFilterInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
        }
    };

    // Mirrors Comando's `.sidebar-search` (styles.css:626): padding-based
    // sizing (no fixed height), 12px/18px text, 12px icon, 6px gap. Keeps
    // the bar quietly translucent so it blends into the sidebar vibrancy.
    return (
        <div
            className="flex items-center rounded-md"
            style={{
                gap: 6,
                padding: "4px 8px",
                backgroundColor:
                    "color-mix(in srgb, var(--bg-tertiary) 85%, transparent)",
                border:
                    "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                transition:
                    "background-color 120ms ease, border-color 120ms ease",
            }}
            onClick={() => inputRef.current?.focus()}
        >
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                    color: "var(--text-secondary)",
                    flexShrink: 0,
                }}
            >
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
            </svg>
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                aria-label={ariaLabel ?? placeholder}
                autoCapitalize="off"
                autoCorrect="off"
                className="flex-1 bg-transparent outline-none border-0"
                style={{
                    color: "var(--text-primary)",
                    minWidth: 0,
                    fontSize: 12,
                    lineHeight: "18px",
                }}
                spellCheck={false}
            />
            {value && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onChange("");
                        inputRef.current?.focus();
                    }}
                    title="Clear filter"
                    aria-label="Clear filter"
                    className="flex items-center justify-center rounded-[3px] transition-colors"
                    style={{
                        color: "var(--text-secondary)",
                        width: 16,
                        height: 16,
                        flexShrink: 0,
                    }}
                >
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                    >
                        <path d="M4 4l8 8M4 12l8-8" />
                    </svg>
                </button>
            )}
        </div>
    );
}
