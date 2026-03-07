import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "../../app/store/settingsStore";

const FM_COLLAPSED_KEY = "vaultai:fm-collapsed";

export type FrontmatterValue = string | string[] | null;
export interface FrontmatterEntry {
    key: string;
    value: FrontmatterValue;
}

type PropType = "text" | "url" | "date" | "list" | "tags";

export function parseFrontmatterRaw(raw: string): FrontmatterEntry[] {
    const yamlText = raw
        .replace(/^---\r?\n/, "")
        .replace(/\r?\n---(\r?\n|$)$/, "");
    const entries: FrontmatterEntry[] = [];
    const lines = yamlText.split("\n");
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }

        const kvMatch = line.match(/^([^:]+):\s*(.*)/);
        if (!kvMatch) {
            i++;
            continue;
        }

        const key = kvMatch[1].trim();
        const inlineVal = kvMatch[2].trim().replace(/^["']|["']$/g, "");

        if (inlineVal) {
            entries.push({ key, value: inlineVal });
            i++;
            continue;
        }

        const items: string[] = [];
        i++;
        while (i < lines.length) {
            const arrayMatch = lines[i].match(/^[ \t]+-\s+(.*)/);
            if (!arrayMatch) break;
            const val = arrayMatch[1]
                .trim()
                .replace(/^["']|["']$/g, "")
                .replace(/^\[\[|\]\]$/g, "");
            items.push(val);
            i++;
        }

        entries.push({ key, value: items.length > 0 ? items : "" });
    }

    return entries;
}

export function serializeFrontmatterRaw(entries: FrontmatterEntry[]): string | null {
    const cleaned = entries
        .map(({ key, value }) => ({
            key: key.trim(),
            value:
                Array.isArray(value)
                    ? value.map((item) => item.trim()).filter(Boolean)
                    : typeof value === "string"
                      ? value.trim()
                      : value,
        }))
        .filter(({ key, value }) => {
            if (!key) return false;
            if (Array.isArray(value)) return value.length > 0;
            return value !== null && value !== "";
        });

    if (!cleaned.length) return null;

    const body = cleaned
        .map(({ key, value }) => {
            if (Array.isArray(value)) {
                return `${key}:\n${value.map((item) => `  - ${quoteYaml(item)}`).join("\n")}`;
            }
            return `${key}: ${quoteYaml(typeof value === "string" ? value : "")}`;
        })
        .join("\n");

    return `---\n${body}\n---\n`;
}

function quoteYaml(value: string): string {
    if (!value) return '""';
    if (/^[A-Za-z0-9 _./:@#%+,-]+$/.test(value)) return value;
    return JSON.stringify(value);
}

function parseIsoDate(value: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day, 12);
    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return null;
    }
    return date;
}

function formatIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatDisplayDate(value: string) {
    const date = parseIsoDate(value);
    if (!date) return value;
    return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

function buildCalendarDays(viewMonth: Date) {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const firstDay = new Date(year, month, 1, 12);
    const leading = (firstDay.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - leading, 12);

    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(
            start.getFullYear(),
            start.getMonth(),
            start.getDate() + index,
            12,
        );
        return {
            key: formatIsoDate(date),
            date,
            inMonth: date.getMonth() === month,
        };
    });
}

function shiftMonth(date: Date, offset: number) {
    return new Date(date.getFullYear(), date.getMonth() + offset, 1, 12);
}

function updateEntry(
    entries: FrontmatterEntry[],
    key: string,
    nextValue: FrontmatterValue,
): FrontmatterEntry[] {
    const index = entries.findIndex((entry) => entry.key === key);
    if (index >= 0) {
        return entries.map((entry, currentIndex) =>
            currentIndex === index ? { ...entry, value: nextValue } : entry,
        );
    }
    return [{ key, value: nextValue }, ...entries];
}

function createEntryValue(type: PropType, rawValue: string): FrontmatterValue {
    if (type === "list" || type === "tags") {
        return rawValue
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return rawValue.trim();
}

function detectType(key: string, value: FrontmatterValue): PropType {
    const lk = key.toLowerCase();
    if (lk === "tags" || lk === "tag") return "tags";
    if (Array.isArray(value)) return "list";
    if (typeof value === "string") {
        if (/^https?:\/\//.test(value)) return "url";
        if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
    }
    return "text";
}

function shouldUseTextarea(name: string, value: FrontmatterValue) {
    if (Array.isArray(value) || typeof value !== "string") return false;
    const key = name.toLowerCase();
    return (
        value.length > 56 ||
        ["summary", "resumen", "description", "descripcion", "excerpt"].includes(
            key,
        )
    );
}

function TextIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
                d="M2 4h12M2 8h8M2 12h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
            />
        </svg>
    );
}

function LinkIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
                d="M6.5 9.5a3.5 3.5 0 0 0 4.95 0l2-2a3.5 3.5 0 0 0-4.95-4.95l-1 1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
            />
            <path
                d="M9.5 6.5a3.5 3.5 0 0 0-4.95 0l-2 2a3.5 3.5 0 0 0 4.95 4.95l1-1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
            />
        </svg>
    );
}

function CalendarIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <rect
                x="2"
                y="3"
                width="12"
                height="11"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.4"
            />
            <path
                d="M5 2v2M11 2v2M2 7h12"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
            />
        </svg>
    );
}

function TagIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
                d="M2 8.5V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4 0l-5-5A1 1 0 0 1 3 8.5Z"
                stroke="currentColor"
                strokeWidth="1.3"
            />
            <circle cx="5.5" cy="6.5" r="1" fill="currentColor" />
        </svg>
    );
}

function ListIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <circle cx="3" cy="5" r="1" fill="currentColor" />
            <circle cx="3" cy="8" r="1" fill="currentColor" />
            <circle cx="3" cy="11" r="1" fill="currentColor" />
            <path
                d="M6 5h7M6 8h7M6 11h5"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
            />
        </svg>
    );
}

function TypeIcon({ type }: { type: PropType }) {
    switch (type) {
        case "url":
            return <LinkIcon />;
        case "date":
            return <CalendarIcon />;
        case "tags":
            return <TagIcon />;
        case "list":
            return <ListIcon />;
        default:
            return <TextIcon />;
    }
}

function Pill({ label, fontSize }: { label: string; fontSize: number }) {
    return (
        <span
            className="px-2 py-0.5 rounded-full"
            style={{
                fontSize,
                backgroundColor:
                    "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
            }}
        >
            {label}
        </span>
    );
}

function DateField({
    value,
    fontSize,
    onChange,
}: {
    value: string;
    fontSize: number;
    onChange: (nextValue: string) => void;
}) {
    const parsed = parseIsoDate(value);
    const [open, setOpen] = useState(false);
    const [viewMonth, setViewMonth] = useState(
        parsed ? new Date(parsed.getFullYear(), parsed.getMonth(), 1, 12) : new Date(),
    );
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const handleDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open]);

    useEffect(() => {
        if (parsed) {
            setViewMonth(new Date(parsed.getFullYear(), parsed.getMonth(), 1, 12));
        }
    }, [value]);

    const days = useMemo(() => buildCalendarDays(viewMonth), [viewMonth]);
    const today = formatIsoDate(new Date());
    const selected = parsed ? formatIsoDate(parsed) : null;

    return (
        <div ref={rootRef} style={{ position: "relative" }}>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="w-full flex items-center gap-2 text-left"
                style={{
                    minHeight: 38,
                    padding: "6px 10px",
                    borderRadius: 12,
                    border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                    background:
                        "color-mix(in srgb, var(--bg-primary) 80%, var(--bg-secondary))",
                    color: "var(--text-primary)",
                    fontSize,
                }}
            >
                <span style={{ flex: 1, minWidth: 0 }}>
                    {value ? formatDisplayDate(value) : "Select a date"}
                </span>
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ opacity: 0.55, flexShrink: 0 }}
                >
                    <path
                        d="M3 5l5 5 5-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>
            {open && (
                <div
                    style={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        left: 0,
                        zIndex: 50,
                        width: 272,
                        padding: 12,
                        borderRadius: 16,
                        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 94%, var(--bg-secondary))",
                        boxShadow: "0 18px 40px rgba(0,0,0,0.14)",
                        backdropFilter: "blur(12px)",
                    }}
                >
                    <div
                        className="flex items-center justify-between"
                        style={{ marginBottom: 10 }}
                    >
                        <button
                            type="button"
                            onClick={() => setViewMonth((prev) => shiftMonth(prev, -1))}
                            className="h-8 w-8 rounded-full"
                            style={{
                                border: "1px solid transparent",
                                color: "var(--text-secondary)",
                            }}
                        >
                            ‹
                        </button>
                        <div
                            style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: "var(--text-primary)",
                                letterSpacing: "0.01em",
                            }}
                        >
                            {viewMonth.toLocaleDateString(undefined, {
                                month: "long",
                                year: "numeric",
                            })}
                        </div>
                        <button
                            type="button"
                            onClick={() => setViewMonth((prev) => shiftMonth(prev, 1))}
                            className="h-8 w-8 rounded-full"
                            style={{
                                border: "1px solid transparent",
                                color: "var(--text-secondary)",
                            }}
                        >
                            ›
                        </button>
                    </div>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                            gap: 4,
                            marginBottom: 6,
                        }}
                    >
                        {["M", "T", "W", "T", "F", "S", "S"].map((label) => (
                            <div
                                key={label}
                                style={{
                                    height: 24,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                    fontWeight: 600,
                                }}
                            >
                                {label}
                            </div>
                        ))}
                    </div>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                            gap: 4,
                        }}
                    >
                        {days.map(({ key, date, inMonth }) => {
                            const iso = formatIsoDate(date);
                            const isSelected = selected === iso;
                            const isToday = today === iso;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => {
                                        onChange(iso);
                                        setOpen(false);
                                    }}
                                    className="rounded-xl"
                                    style={{
                                        height: 34,
                                        fontSize: 12,
                                        fontWeight: isSelected ? 700 : 500,
                                        border: isSelected
                                            ? "1px solid color-mix(in srgb, var(--accent) 65%, transparent)"
                                            : isToday
                                              ? "1px solid color-mix(in srgb, var(--border) 90%, transparent)"
                                              : "1px solid transparent",
                                        background: isSelected
                                            ? "color-mix(in srgb, var(--accent) 18%, var(--bg-primary))"
                                            : isToday
                                              ? "color-mix(in srgb, var(--bg-secondary) 82%, transparent)"
                                              : "transparent",
                                        color: inMonth
                                            ? "var(--text-primary)"
                                            : "var(--text-secondary)",
                                        opacity: inMonth ? 1 : 0.42,
                                    }}
                                >
                                    {date.getDate()}
                                </button>
                            );
                        })}
                    </div>
                    <div
                        className="flex items-center justify-between"
                        style={{ marginTop: 10, gap: 8 }}
                    >
                        <button
                            type="button"
                            onClick={() => {
                                onChange(today);
                                setOpen(false);
                            }}
                            className="px-3 h-8 rounded-full"
                            style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                                border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                                background:
                                    "color-mix(in srgb, var(--bg-secondary) 78%, transparent)",
                            }}
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                onChange("");
                                setOpen(false);
                            }}
                            className="px-3 h-8 rounded-full"
                            style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: "var(--text-secondary)",
                                border: "1px solid transparent",
                                background: "transparent",
                            }}
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function AutoGrowTextarea({
    value,
    rows = 3,
    style,
    onChange,
}: {
    value: string;
    rows?: number;
    style: CSSProperties;
    onChange: (nextValue: string) => void;
}) {
    const ref = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);

    return (
        <textarea
            ref={ref}
            value={value}
            rows={rows}
            onChange={(e) => onChange(e.target.value)}
            style={{
                ...style,
                resize: "none",
                overflow: "hidden",
                lineHeight: 1.5,
            }}
        />
    );
}

function PropertyEditor({
    name,
    value,
    type,
    fontSize,
    pillFontSize,
    onChange,
}: {
    name: string;
    value: FrontmatterValue;
    type: PropType;
    fontSize: number;
    pillFontSize: number;
    onChange?: (nextValue: FrontmatterValue) => void;
}) {
    const commonInputStyle = {
        width: "100%",
        minWidth: 0,
        fontSize,
        color: "var(--text-primary)",
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 10,
        padding: "6px 8px",
        outline: "none",
    } as const;

    if (!onChange) {
        if (!value) return null;
        if (Array.isArray(value)) {
            return (
                <div className="flex flex-wrap gap-1.5">
                    {value.map((item, i) => (
                        <Pill key={i} label={item} fontSize={pillFontSize} />
                    ))}
                </div>
            );
        }

        if (type === "url") {
            return (
                <a
                    href="#"
                    onClick={(e) => {
                        e.preventDefault();
                        void openUrl(String(value));
                    }}
                    style={{ ...commonInputStyle, color: "var(--accent)" }}
                >
                    {String(value)}
                </a>
            );
        }

        return (
            <span
                style={{
                    fontSize,
                    wordBreak: "break-word",
                    display: "block",
                    padding: "6px 8px",
                }}
            >
                {value}
            </span>
        );
    }

    if (Array.isArray(value) || type === "list" || type === "tags") {
        const joined = Array.isArray(value) ? value.join(", ") : "";
        return (
            <div className="space-y-2">
                <input
                    value={joined}
                    onChange={(e) =>
                        onChange(
                            e.target.value
                                .split(",")
                                .map((item) => item.trim())
                                .filter(Boolean),
                        )
                    }
                    placeholder="item 1, item 2, item 3"
                    style={commonInputStyle}
                />
                {Array.isArray(value) && value.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-1">
                        {value.map((item, i) => (
                            <Pill key={i} label={item} fontSize={pillFontSize} />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (type === "date") {
        return (
            <DateField
                value={typeof value === "string" ? value.slice(0, 10) : ""}
                fontSize={fontSize}
                onChange={onChange}
            />
        );
    }

    if (shouldUseTextarea(name, value)) {
        return (
            <AutoGrowTextarea
                value={typeof value === "string" ? value : ""}
                rows={3}
                onChange={onChange}
                style={commonInputStyle}
            />
        );
    }

    return (
        <div className="flex items-center gap-2">
            <input
                type={type === "url" ? "url" : "text"}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                style={commonInputStyle}
            />
            {type === "url" && typeof value === "string" && value && (
                <button
                    onClick={() => void openUrl(value)}
                    className="px-2.5 h-8 rounded-lg text-xs"
                    style={{
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border)",
                        background: "var(--bg-primary)",
                        flexShrink: 0,
                    }}
                >
                    Open
                </button>
            )}
        </div>
    );
}

function PropertyRow({
    name,
    value,
    labelFontSize,
    valueFontSize,
    pillFontSize,
    onChange,
}: {
    name: string;
    value: FrontmatterValue;
    labelFontSize: number;
    valueFontSize: number;
    pillFontSize: number;
    onChange?: (nextValue: FrontmatterValue) => void;
}) {
    const type = detectType(name, value);
    return (
        <div
            className="flex items-start gap-3 px-4 py-2"
            style={{ borderTop: "1px solid var(--border)" }}
        >
            <div
                className="flex items-center gap-1.5 flex-shrink-0"
                style={{
                    width: 96,
                    color: "var(--text-secondary)",
                    paddingTop: 8,
                    fontSize: labelFontSize,
                }}
            >
                <div style={{ opacity: 0.48 }}>
                    <TypeIcon type={type} />
                </div>
                <span className="truncate">{name}</span>
            </div>
            <div className="flex-1 min-w-0" style={{ color: "var(--text-primary)" }}>
                <PropertyEditor
                    name={name}
                    value={value}
                    type={type}
                    fontSize={valueFontSize}
                    pillFontSize={pillFontSize}
                    onChange={onChange}
                />
            </div>
        </div>
    );
}

function AddPropertyComposer({
    fontSize,
    onAdd,
}: {
    fontSize: number;
    onAdd: (key: string, value: FrontmatterValue) => void;
}) {
    const [open, setOpen] = useState(false);
    const [key, setKey] = useState("");
    const [type, setType] = useState<PropType>("text");
    const [value, setValue] = useState("");

    const reset = () => {
        setOpen(false);
        setKey("");
        setType("text");
        setValue("");
    };

    const submit = () => {
        const trimmedKey = key.trim();
        const nextValue = createEntryValue(type, value);
        const hasValue =
            Array.isArray(nextValue) ? nextValue.length > 0 : nextValue !== "";
        if (!trimmedKey || !hasValue) return;
        onAdd(trimmedKey, nextValue);
        reset();
    };

    if (!open) {
        return (
            <div
                style={{
                    borderTop: "1px solid var(--border)",
                    padding: "12px 16px 14px",
                }}
            >
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="inline-flex items-center gap-2 rounded-full px-3 h-8"
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-secondary)",
                        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 72%, var(--bg-secondary))",
                    }}
                >
                    <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
                    Add property
                </button>
            </div>
        );
    }

    return (
        <div
            style={{
                borderTop: "1px solid var(--border)",
                padding: "14px 16px 16px",
            }}
        >
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1.1fr) 120px minmax(0, 1.6fr)",
                    gap: 8,
                }}
            >
                <input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="Property name"
                    style={{
                        minWidth: 0,
                        height: 36,
                        padding: "0 10px",
                        borderRadius: 10,
                        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 78%, var(--bg-secondary))",
                        color: "var(--text-primary)",
                        fontSize,
                    }}
                />
                <select
                    value={type}
                    onChange={(e) => setType(e.target.value as PropType)}
                    style={{
                        minWidth: 0,
                        height: 36,
                        padding: "0 10px",
                        borderRadius: 10,
                        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 78%, var(--bg-secondary))",
                        color: "var(--text-primary)",
                        fontSize,
                    }}
                >
                    <option value="text">Text</option>
                    <option value="url">URL</option>
                    <option value="date">Date</option>
                    <option value="list">List</option>
                    <option value="tags">Tags</option>
                </select>
                {type === "date" ? (
                    <DateField value={value} fontSize={fontSize} onChange={setValue} />
                ) : (
                    <input
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={
                            type === "list" || type === "tags"
                                ? "item 1, item 2, item 3"
                                : "Value"
                        }
                        style={{
                            minWidth: 0,
                            height: 36,
                            padding: "0 10px",
                            borderRadius: 10,
                            border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                            background:
                                "color-mix(in srgb, var(--bg-primary) 78%, var(--bg-secondary))",
                            color: "var(--text-primary)",
                            fontSize,
                        }}
                    />
                )}
            </div>
            <div
                className="flex items-center justify-end gap-2"
                style={{ marginTop: 10 }}
            >
                <button
                    type="button"
                    onClick={reset}
                    className="px-3 h-8 rounded-full"
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-secondary)",
                        border: "1px solid transparent",
                        background: "transparent",
                    }}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={submit}
                    className="px-3 h-8 rounded-full"
                    style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                        border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                        background:
                            "color-mix(in srgb, var(--accent) 14%, var(--bg-primary))",
                    }}
                >
                    Save
                </button>
            </div>
        </div>
    );
}

export function FrontmatterPanel({
    raw,
    onChange,
}: {
    raw: string;
    onChange?: (nextRaw: string | null) => void;
}) {
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const [collapsed, setCollapsed] = useState(
        () => localStorage.getItem(FM_COLLAPSED_KEY) === "true",
    );

    const headerFontSize = Math.max(11, Math.round(editorFontSize * 0.86));
    const labelFontSize = Math.max(11, Math.round(editorFontSize * 0.86));
    const valueFontSize = Math.max(12, editorFontSize);
    const pillFontSize = Math.max(11, Math.round(editorFontSize * 0.86));

    const entries = useMemo(() => parseFrontmatterRaw(raw), [raw]);
    if (entries.length === 0 && !onChange) return null;

    const toggleCollapsed = () => {
        const next = !collapsed;
        setCollapsed(next);
        localStorage.setItem(FM_COLLAPSED_KEY, String(next));
    };

    const handleEntryChange = (key: string, nextValue: FrontmatterValue) => {
        if (!onChange) return;
        onChange(serializeFrontmatterRaw(updateEntry(entries, key, nextValue)));
    };

    const handleAddProperty = (key: string, value: FrontmatterValue) => {
        if (!onChange) return;
        onChange(serializeFrontmatterRaw([...entries, { key, value }]));
    };

    return (
        <div
            style={{
                marginBottom: 8,
                borderRadius: 12,
                border: "1px solid var(--border)",
                background:
                    "color-mix(in srgb, var(--bg-secondary) 88%, transparent)",
                overflow: "visible",
            }}
        >
            <button
                onClick={toggleCollapsed}
                className="flex items-center gap-2 w-full text-left px-4"
                style={{ height: 36, color: "var(--text-secondary)" }}
                onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "var(--text-primary)")
                }
                onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "var(--text-secondary)")
                }
            >
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{
                        transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                        transition: "transform 120ms ease",
                        opacity: 0.5,
                        flexShrink: 0,
                    }}
                >
                    <path
                        d="M3 5l5 5 5-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
                <span
                    className="font-medium"
                    style={{
                        fontSize: headerFontSize,
                        letterSpacing: "0.04em",
                    }}
                >
                    Properties
                </span>
                <span
                    className="ml-auto"
                    style={{ fontSize: headerFontSize, opacity: 0.35 }}
                >
                    {entries.length}
                </span>
            </button>

            {!collapsed &&
                entries.map(({ key, value }) => (
                    <PropertyRow
                        key={key}
                        name={key}
                        value={value}
                        labelFontSize={labelFontSize}
                        valueFontSize={valueFontSize}
                        pillFontSize={pillFontSize}
                        onChange={
                            onChange
                                ? (nextValue) => handleEntryChange(key, nextValue)
                                : undefined
                        }
                    />
                ))}
            {!collapsed && onChange && (
                <AddPropertyComposer
                    fontSize={valueFontSize}
                    onAdd={handleAddProperty}
                />
            )}
        </div>
    );
}
