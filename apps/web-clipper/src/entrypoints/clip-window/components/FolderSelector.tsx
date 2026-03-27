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
                className="shrink-0 text-[#FFB547]"
            >
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
            <input
                value={value}
                list={listId}
                onChange={(event) =>
                    onChange(normalizeFolderHint(event.target.value))
                }
                placeholder="folder"
                className="min-w-0 flex-1 truncate bg-transparent text-[11px] font-medium text-fg outline-none placeholder:text-fg-dim"
            />
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
            <datalist id={listId}>
                {suggestions.map((folder) => (
                    <option key={folder} value={folder} />
                ))}
            </datalist>
        </div>
    );
}

export default FolderSelector;
