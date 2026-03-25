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
    return (
        <div className="grid min-w-[280px] gap-3">
            <div className="flex flex-wrap gap-2">
                {options.slice(0, 4).map((option) => {
                    const isActive = option.value === value;

                    return (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => onChange(option.value)}
                            className={`inline-flex h-9 items-center justify-center rounded-full border px-3 text-xs font-semibold transition ${
                                isActive
                                    ? "border-accent/35 bg-accent/15 text-fg"
                                    : "border-edge bg-surface-raised text-fg-muted hover:border-accent/25 hover:text-fg"
                            }`}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>

            <label className="grid gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    Vault
                </span>
                <select
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    className="h-11 rounded-[10px] border border-edge bg-surface-alt px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                >
                    {options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </label>
        </div>
    );
}

export default VaultSelector;
