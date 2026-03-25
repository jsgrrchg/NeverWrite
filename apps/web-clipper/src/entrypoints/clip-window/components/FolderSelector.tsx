import { normalizeFolderHint } from "../../../lib/clipper-preferences";

interface FolderSelectorProps {
    value: string;
    suggestions: string[];
    onChange: (value: string) => void;
}

export function FolderSelector({
    value,
    suggestions,
    onChange,
}: FolderSelectorProps) {
    const listId = "folder-hints";

    return (
        <div className="grid gap-3">
            <label className="grid gap-2">
                <span className="text-sm font-medium text-fg">
                    Destination folder
                </span>
                <input
                    value={value}
                    list={listId}
                    onChange={(event) =>
                        onChange(normalizeFolderHint(event.target.value))
                    }
                    placeholder="Clips/Web"
                    className="h-11 rounded-[10px] border border-edge bg-surface-raised px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                />
            </label>

            <datalist id={listId}>
                {suggestions.map((folder) => (
                    <option key={folder} value={folder} />
                ))}
            </datalist>

            {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {suggestions.slice(0, 8).map((folder) => (
                        <button
                            key={folder}
                            type="button"
                            onClick={() => onChange(folder)}
                            className="inline-flex items-center rounded-full border border-edge bg-surface-raised px-3 py-1 text-xs font-medium text-fg-muted transition hover:border-accent/35 hover:text-fg"
                        >
                            {folder}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default FolderSelector;
