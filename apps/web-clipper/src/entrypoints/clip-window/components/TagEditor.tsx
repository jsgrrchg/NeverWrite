import { useState } from "react";
import { parseTagInput } from "../../../lib/clipper-preferences";

interface TagEditorProps {
    tags: string[];
    suggestions: string[];
    onChange: (tags: string[]) => void;
}

export function TagEditor({ tags, suggestions, onChange }: TagEditorProps) {
    const [draft, setDraft] = useState("");

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
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-edge bg-surface-raised px-2.5 py-1.5">
            {tags.map((tag, index) => (
                <button
                    key={tag}
                    type="button"
                    onClick={() => removeTag(tag)}
                    className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium transition ${
                        index === 0
                            ? "bg-accent/[0.12] text-accent"
                            : "bg-fg/[0.06] text-fg-muted"
                    }`}
                >
                    {tag}
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
                list="tag-suggestions"
                placeholder={tags.length === 0 ? "Add tag" : "+ Add tag"}
                className="min-w-15 flex-1 bg-transparent text-[10px] text-fg-dim outline-none placeholder:text-fg-dim"
            />
            {suggestions.length > 0 && (
                <datalist id="tag-suggestions">
                    {suggestions
                        .filter(
                            (s) =>
                                !tags
                                    .map((t) => t.toLowerCase())
                                    .includes(s.toLowerCase()),
                        )
                        .map((suggestion) => (
                            <option key={suggestion} value={suggestion} />
                        ))}
                </datalist>
            )}
        </div>
    );
}

export default TagEditor;
