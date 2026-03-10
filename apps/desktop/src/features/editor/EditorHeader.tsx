import { useEffect, useRef, useState, useLayoutEffect } from "react";

export function MetaBadge({
    label,
    tone = "muted",
}: {
    label: string;
    tone?: "muted" | "accent" | "success";
}) {
    const palette =
        tone === "accent"
            ? {
                  color: "var(--accent)",
                  background:
                      "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
                  border: "color-mix(in srgb, var(--accent) 24%, var(--border))",
              }
            : tone === "success"
              ? {
                    color: "#15803d",
                    background:
                        "color-mix(in srgb, #22c55e 10%, var(--bg-primary))",
                    border: "color-mix(in srgb, #22c55e 22%, var(--border))",
                }
              : {
                    color: "var(--text-secondary)",
                    background:
                        "color-mix(in srgb, var(--bg-secondary) 82%, transparent)",
                    border: "var(--border)",
                };

    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 28,
                padding: "0 11px",
                borderRadius: 999,
                border: `1px solid ${palette.border}`,
                background: palette.background,
                color: palette.color,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.01em",
            }}
        >
            {label}
        </span>
    );
}

export function EditableNoteTitle({
    value,
    onChange,
    textareaRef,
    onContextMenu,
}: {
    value: string;
    onChange: (nextValue: string) => void;
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
    onContextMenu?: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
}) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        if (textareaRef) {
            textareaRef.current = ref.current;
        }
    }, [textareaRef]);

    useEffect(() => {
        if (document.activeElement !== ref.current) {
            setDraft(value);
        }
    }, [value]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = `${el.scrollHeight}px`;
    }, [draft]);

    return (
        <textarea
            ref={ref}
            value={draft}
            rows={1}
            spellCheck={false}
            onChange={(e) => {
                const nextValue = e.target.value.replace(/\r?\n+/g, " ");
                setDraft(nextValue);
                onChange(nextValue);
            }}
            onContextMenu={onContextMenu}
            style={{
                width: "100%",
                resize: "none",
                overflow: "hidden",
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: 16,
                padding: "6px 8px",
                margin: "-6px -8px 0",
                fontSize: "2rem",
                fontWeight: 750,
                color: "var(--text-primary)",
                lineHeight: 1.1,
                letterSpacing: "-0.03em",
                outline: "none",
            }}
            onFocus={(e) => {
                e.currentTarget.style.borderColor =
                    "color-mix(in srgb, var(--accent) 22%, transparent)";
                e.currentTarget.style.background =
                    "color-mix(in srgb, var(--bg-secondary) 78%, transparent)";
            }}
            onBlur={(e) => {
                e.currentTarget.style.borderColor = "transparent";
                e.currentTarget.style.background = "transparent";
            }}
        />
    );
}
