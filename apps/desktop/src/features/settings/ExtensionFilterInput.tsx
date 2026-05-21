import { useRef, useState } from "react";

function parseExtensionTokens(value: string): string[] {
    return value
        .split(/[,\s]+/)
        .map((item) => item.trim().replace(/^\.+/, "").toLowerCase())
        .filter(Boolean);
}

export function ExtensionFilterInput({
    value,
    onChange,
}: {
    value: string[];
    onChange: (value: string[]) => void;
}) {
    const [draft, setDraft] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const addExtensions = (raw: string) => {
        const tokens = parseExtensionTokens(raw);
        if (tokens.length === 0) return;

        const seen = new Set(value);
        const next = [...value];
        for (const token of tokens) {
            if (seen.has(token)) continue;
            seen.add(token);
            next.push(token);
        }
        onChange(next);
        setDraft("");
    };

    const removeExtension = (extension: string) => {
        onChange(value.filter((item) => item !== extension));
    };

    return (
        <div
            role="group"
            aria-label="File extension filter"
            onClick={() => inputRef.current?.focus()}
            style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 6,
                width: 260,
                minHeight: 30,
                padding: "4px 6px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                backgroundColor: "var(--bg-tertiary)",
                cursor: "text",
            }}
        >
            {value.map((extension) => (
                <span
                    key={extension}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        maxWidth: 120,
                        borderRadius: 999,
                        padding: "2px 6px",
                        backgroundColor:
                            "color-mix(in srgb, var(--accent) 14%, transparent)",
                        color: "var(--text-primary)",
                        fontSize: 11,
                        lineHeight: 1.2,
                    }}
                >
                    <span
                        style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        .{extension}
                    </span>
                    <button
                        type="button"
                        aria-label={`Remove .${extension}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            removeExtension(extension);
                        }}
                        style={{
                            border: "none",
                            padding: 0,
                            background: "transparent",
                            color: "var(--text-secondary)",
                            cursor: "pointer",
                            fontSize: 13,
                            lineHeight: 1,
                        }}
                    >
                        &times;
                    </button>
                </span>
            ))}
            <input
                ref={inputRef}
                value={draft}
                aria-label="Add file extension"
                placeholder={value.length === 0 ? "Add: pdf, txt, csv..." : ""}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onPaste={(event) => {
                    const pasted = event.clipboardData.getData("text");
                    if (parseExtensionTokens(pasted).length <= 1) return;
                    event.preventDefault();
                    addExtensions(pasted);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === ",") {
                        event.preventDefault();
                        addExtensions(draft);
                        return;
                    }
                    if (
                        event.key === "Backspace" &&
                        draft.length === 0 &&
                        value.length > 0
                    ) {
                        onChange(value.slice(0, -1));
                    }
                }}
                onBlur={() => addExtensions(draft)}
                style={{
                    flex: "1 1 88px",
                    minWidth: 74,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    fontFamily: "inherit",
                }}
            />
        </div>
    );
}
