import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

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
                maxWidth: "100%",
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
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState(value);
    const [isFocused, setIsFocused] = useState(false);

    const resizeToFit = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = `${el.scrollHeight}px`;
    }, []);

    useEffect(() => {
        if (textareaRef) {
            textareaRef.current = ref.current;
        }
    }, [textareaRef]);

    useEffect(() => {
        setDraft(value);
    }, [value]);

    const visibleValue = isFocused ? draft : value;

    useLayoutEffect(() => {
        resizeToFit();
    }, [resizeToFit, visibleValue]);

    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper || typeof ResizeObserver === "undefined") return;

        let frame = 0;
        let lastWidth = -1;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const nextWidth = Math.round(entry.contentRect.width);
            if (nextWidth === lastWidth) return;
            lastWidth = nextWidth;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                resizeToFit();
            });
        });

        observer.observe(wrapper);

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [resizeToFit]);

    useEffect(() => {
        if (typeof document === "undefined" || !("fonts" in document)) return;

        let cancelled = false;
        void document.fonts.ready.then(() => {
            if (!cancelled) {
                resizeToFit();
            }
        });

        return () => {
            cancelled = true;
        };
    }, [resizeToFit]);

    return (
        <div ref={wrapperRef} style={{ width: "100%", minWidth: 0 }}>
            <textarea
                ref={ref}
                value={visibleValue}
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
                    minWidth: 0,
                    display: "block",
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
                    setIsFocused(true);
                    setDraft(value);
                    e.currentTarget.style.borderColor =
                        "color-mix(in srgb, var(--accent) 22%, transparent)";
                    e.currentTarget.style.background =
                        "color-mix(in srgb, var(--bg-secondary) 78%, transparent)";
                }}
                onBlur={(e) => {
                    setIsFocused(false);
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.background = "transparent";
                }}
            />
        </div>
    );
}
