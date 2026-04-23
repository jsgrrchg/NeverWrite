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

    return (
        <div
            className="flex items-center gap-1 px-1.5 rounded-md focus-within:ring-1"
            style={{
                height: 22,
                backgroundColor:
                    "color-mix(in srgb, var(--bg-tertiary) 55%, transparent)",
                border:
                    "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
            }}
            onClick={() => inputRef.current?.focus()}
        >
            <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                    color: "var(--text-secondary)",
                    opacity: 0.6,
                    flexShrink: 0,
                }}
            >
                <circle cx="7" cy="7" r="4" />
                <path d="M10 10L13.5 13.5" />
            </svg>
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                aria-label={ariaLabel ?? placeholder}
                className="flex-1 bg-transparent text-[11px] outline-none"
                style={{ color: "var(--text-primary)", minWidth: 0 }}
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
                    className="flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
                    style={{
                        color: "var(--text-secondary)",
                        width: 12,
                        height: 12,
                        flexShrink: 0,
                    }}
                >
                    <svg
                        width="9"
                        height="9"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                    >
                        <path d="M4 4l8 8M4 12l8-8" />
                    </svg>
                </button>
            )}
        </div>
    );
}
