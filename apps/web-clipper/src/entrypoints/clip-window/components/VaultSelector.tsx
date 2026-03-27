interface VaultSelectorProps {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
}

export function VaultSelector({
    value,
    options,
    onChange,
}: VaultSelectorProps) {
    const activeLabel =
        options.find((o) => o.value === value)?.label ?? "Select vault";

    return (
        <div className="relative flex h-7 flex-1 items-center gap-1.5 rounded-md border border-edge bg-surface-raised px-2.5">
            <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-accent"
            >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M7 3v18" />
                <path d="M3 7.5h4" />
                <path d="M3 12h18" />
                <path d="M3 16.5h4" />
            </svg>
            <span className="flex-1 truncate text-[11px] font-medium text-fg">
                {activeLabel}
            </span>
            {options.length > 1 && (
                <span className="rounded-sm bg-[#FFFFFF08] px-1.5 py-0.5 text-[10px] text-fg-dim">
                    {options.length} vaults
                </span>
            )}
            <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-fg-dim"
            >
                <path d="m6 9 6 6 6-6" />
            </svg>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

export default VaultSelector;
