import { useMemo, useState } from "react";
import { parseTagInput } from "../../../lib/clipper-preferences";

interface TagEditorProps {
    tags: string[];
    suggestions: string[];
    onChange: (tags: string[]) => void;
}

export function TagEditor({ tags, suggestions, onChange }: TagEditorProps) {
    const [draft, setDraft] = useState("");

    const filteredSuggestions = useMemo(() => {
        const normalizedDraft = draft.trim().toLowerCase();
        const currentKeys = new Set(tags.map((tag) => tag.toLowerCase()));

        return suggestions.filter((suggestion) => {
            const key = suggestion.toLowerCase();
            if (currentKeys.has(key)) {
                return false;
            }

            return !normalizedDraft || key.includes(normalizedDraft);
        });
    }, [draft, suggestions, tags]);

    function commitDraft(value: string) {
        const nextTags = parseTagInput(value);
        if (nextTags.length === 0) {
            setDraft("");
            return;
        }

        onChange(parseTagInput([...tags, ...nextTags].join(",")));
        setDraft("");
    }

    function removeTag(tagToRemove: string) {
        onChange(tags.filter((tag) => tag !== tagToRemove));
    }

    return (
        <div className="grid gap-3">
            <div className="flex min-h-11 flex-wrap gap-2 rounded-[10px] border border-edge bg-surface-raised px-3 py-3 transition focus-within:border-accent/60">
                {tags.map((tag) => (
                    <button
                        key={tag}
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/12 px-3 py-1 text-xs font-medium text-fg transition hover:bg-accent/18"
                    >
                        <span>{tag}</span>
                        <span aria-hidden="true" className="text-fg-muted">
                            ×
                        </span>
                    </button>
                ))}
                <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitDraft(draft)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === ",") {
                            event.preventDefault();
                            commitDraft(draft);
                        }

                        if (
                            event.key === "Backspace" &&
                            !draft &&
                            tags.length > 0
                        ) {
                            removeTag(tags[tags.length - 1]);
                        }
                    }}
                    placeholder={
                        tags.length === 0 ? "Add tags" : "Add another tag"
                    }
                    className="min-w-[180px] flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
                />
            </div>

            {filteredSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {filteredSuggestions.slice(0, 8).map((suggestion) => (
                        <button
                            key={suggestion}
                            type="button"
                            onClick={() => commitDraft(suggestion)}
                            className="inline-flex items-center rounded-full border border-edge bg-surface-raised px-3 py-1 text-xs font-medium text-fg-muted transition hover:border-accent/35 hover:text-fg"
                        >
                            {suggestion}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default TagEditor;
