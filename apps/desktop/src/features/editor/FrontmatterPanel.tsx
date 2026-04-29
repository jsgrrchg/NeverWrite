/* eslint-disable react-refresh/only-export-components */
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import { openUrl } from "@neverwrite/runtime";
import { useSettingsStore } from "../../app/store/settingsStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";

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

export function serializeFrontmatterRaw(
    entries: FrontmatterEntry[],
): string | null {
    const cleaned = entries
        .map(({ key, value }) => ({
            key: key.trim(),
            value: Array.isArray(value)
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
        [
            "summary",
            "resumen",
            "description",
            "descripcion",
            "excerpt",
        ].includes(key)
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
            className="px-1.5 py-px rounded-full"
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
        parsed
            ? new Date(parsed.getFullYear(), parsed.getMonth(), 1, 12)
            : new Date(),
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

    const days = useMemo(() => buildCalendarDays(viewMonth), [viewMonth]);
    const today = formatIsoDate(new Date());
    const selected = parsed ? formatIsoDate(parsed) : null;

    return (
        <div
            ref={rootRef}
            style={{
                position: "relative",
                display: "inline-block",
                maxWidth: "100%",
            }}
        >
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="inline-flex items-center gap-2 text-left"
                style={{
                    minHeight: 30,
                    padding: "3px 8px",
                    borderRadius: 8,
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
                        width: 240,
                        padding: 10,
                        borderRadius: 12,
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
                            onClick={() =>
                                setViewMonth((prev) => shiftMonth(prev, -1))
                            }
                            className="h-6 w-6 rounded-full"
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
                            onClick={() =>
                                setViewMonth((prev) => shiftMonth(prev, 1))
                            }
                            className="h-6 w-6 rounded-full"
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
                                        height: 26,
                                        fontSize: 11,
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
                            className="px-2.5 h-6 rounded-full"
                            style={{
                                fontSize: 10,
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
                            className="px-2.5 h-6 rounded-full"
                            style={{
                                fontSize: 10,
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

function PillEditor({
    items,
    fontSize,
    onRemove,
    onAdd,
}: {
    items: string[];
    fontSize: number;
    onRemove: (value: string) => void;
    onAdd: (item: string) => void;
}) {
    const [draft, setDraft] = useState("");

    const commit = () => {
        const trimmed = draft.trim();
        if (trimmed) onAdd(trimmed);
        setDraft("");
    };

    return (
        <div
            className="flex flex-wrap items-center gap-1"
            style={{ padding: "2px 0" }}
        >
            {items.map((item, i) => (
                <span
                    key={`${item}-${i}`}
                    className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full"
                    style={{
                        fontSize,
                        backgroundColor:
                            "color-mix(in srgb, var(--bg-tertiary) 84%, transparent)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border)",
                    }}
                >
                    {item}
                    <button
                        type="button"
                        onClick={() => onRemove(item)}
                        style={{
                            lineHeight: 1,
                            opacity: 0.5,
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "0 1px",
                            color: "inherit",
                            fontSize: fontSize - 1,
                        }}
                    >
                        ×
                    </button>
                </span>
            ))}
            <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        commit();
                    }
                }}
                onBlur={commit}
                placeholder={items.length === 0 ? "Add item…" : "+"}
                style={{
                    fontSize,
                    color: "var(--text-secondary)",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    width:
                        draft.length > 0
                            ? `${draft.length + 2}ch`
                            : items.length === 0
                              ? "7ch"
                              : "2ch",
                    minWidth: "2ch",
                }}
            />
        </div>
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
    const commonInputStyle: CSSProperties = {
        width: "100%",
        fontSize,
        color: "var(--text-primary)",
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        padding: "3px 6px",
        outline: "none",
    };

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
                    style={{
                        ...commonInputStyle,
                        color: "var(--accent)",
                        display: "block",
                        wordBreak: "break-all",
                    }}
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
                    padding: "3px 6px",
                }}
            >
                {value}
            </span>
        );
    }

    if (Array.isArray(value) || type === "list" || type === "tags") {
        const items = Array.isArray(value) ? value : [];
        const removeItem = (value: string) => {
            const idx = items.indexOf(value);
            if (idx !== -1) onChange(items.filter((_, i) => i !== idx));
        };
        return (
            <PillEditor
                items={items}
                fontSize={pillFontSize}
                onRemove={removeItem}
                onAdd={(item) => onChange([...items, item])}
            />
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
                    className="px-2 h-6 rounded-md text-xs"
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
    isFirst = false,
    onChange,
    onContextMenu,
}: {
    name: string;
    value: FrontmatterValue;
    labelFontSize: number;
    valueFontSize: number;
    pillFontSize: number;
    isFirst?: boolean;
    onChange?: (nextValue: FrontmatterValue) => void;
    onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
    const type = detectType(name, value);
    return (
        <div
            className="flex items-start gap-2 pl-3 pr-4 py-1"
            style={{
                borderTop: isFirst
                    ? "none"
                    : "1px solid color-mix(in srgb, var(--border) 35%, transparent)",
            }}
            onContextMenu={onContextMenu}
        >
            <div
                className="flex items-center gap-1.5 shrink-0"
                style={{
                    width: 80,
                    color: "var(--text-secondary)",
                    paddingTop: 5,
                    fontSize: labelFontSize,
                }}
            >
                <div style={{ opacity: 0.48 }}>
                    <TypeIcon type={type} />
                </div>
                <span className="truncate">{name}</span>
            </div>
            <div
                className="flex-1 min-w-0"
                style={{ color: "var(--text-primary)" }}
            >
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

function AddPropertyTriggerButton({ onClick }: { onClick: () => void }) {
    const [hovered, setHovered] = useState(false);
    return (
        <button
            type="button"
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 uppercase transition-colors"
            style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: hovered
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                backgroundColor: hovered
                    ? "color-mix(in srgb, var(--text-primary) 7%, transparent)"
                    : "transparent",
                border: `1px solid color-mix(in srgb, var(--border) ${
                    hovered ? "70%" : "0%"
                }, transparent)`,
                cursor: "pointer",
            }}
        >
            <span style={{ fontSize: 12, lineHeight: 1 }}>+</span>
            Add property
        </button>
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
        const hasValue = Array.isArray(nextValue)
            ? nextValue.length > 0
            : nextValue !== "";
        if (!trimmedKey || !hasValue) return;
        onAdd(trimmedKey, nextValue);
        reset();
    };

    if (!open) {
        return (
            <div
                style={{
                    borderTop:
                        "1px solid color-mix(in srgb, var(--border) 35%, transparent)",
                    padding: "6px 12px",
                }}
            >
                <AddPropertyTriggerButton onClick={() => setOpen(true)} />
            </div>
        );
    }

    return (
        <div
            style={{
                borderTop:
                    "1px solid color-mix(in srgb, var(--border) 35%, transparent)",
                padding: "8px 12px 10px",
            }}
        >
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns:
                        "minmax(0, 1.1fr) 100px minmax(0, 1.6fr)",
                    gap: 6,
                }}
            >
                <input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="Property name"
                    style={{
                        minWidth: 0,
                        height: 28,
                        padding: "0 8px",
                        borderRadius: 6,
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
                        height: 28,
                        padding: "0 8px",
                        borderRadius: 6,
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
                    <DateField
                        value={value}
                        fontSize={fontSize}
                        onChange={setValue}
                    />
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
                            height: 28,
                            padding: "0 8px",
                            borderRadius: 6,
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
                style={{ marginTop: 6 }}
            >
                <button
                    type="button"
                    onClick={reset}
                    className="px-2.5 h-6 rounded-full"
                    style={{
                        fontSize: 11,
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
                    className="px-2.5 h-6 rounded-full"
                    style={{
                        fontSize: 11,
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

/**
 * Headless frontmatter body — externally controlled, no collapse toggle.
 * Used by MarkdownNoteHeader to render properties below the toolbar.
 */
export function FrontmatterBody({
    raw,
    onChange,
}: {
    raw: string | null;
    onChange: (nextRaw: string | null) => void;
}) {
    const editorFontSize = useSettingsStore((s) => s.editorFontSize);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        kind: "entry";
        key: string;
        value: FrontmatterValue;
    }> | null>(null);

    const labelFontSize = Math.max(10, Math.round(editorFontSize * 0.78));
    const valueFontSize = Math.max(11, editorFontSize - 2);
    const pillFontSize = Math.max(10, Math.round(editorFontSize * 0.78));

    const entries = useMemo(() => (raw ? parseFrontmatterRaw(raw) : []), [raw]);

    const handleEntryChange = (key: string, nextValue: FrontmatterValue) => {
        onChange(serializeFrontmatterRaw(updateEntry(entries, key, nextValue)));
    };

    const handleAddProperty = (key: string, value: FrontmatterValue) => {
        onChange(serializeFrontmatterRaw([...entries, { key, value }]));
    };

    return (
        <div
            style={{
                borderTop:
                    "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                borderBottom:
                    "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                background:
                    "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
                overflow: "visible",
            }}
        >
            {entries.map(({ key, value }, index) => (
                <PropertyRow
                    key={key}
                    name={key}
                    value={value}
                    labelFontSize={labelFontSize}
                    valueFontSize={valueFontSize}
                    pillFontSize={pillFontSize}
                    isFirst={index === 0}
                    onChange={(nextValue) => handleEntryChange(key, nextValue)}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            payload: { kind: "entry", key, value },
                        });
                    }}
                />
            ))}
            <AddPropertyComposer
                fontSize={valueFontSize}
                onAdd={handleAddProperty}
            />
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Copy Value",
                            action: () => {
                                const { value } = contextMenu.payload;
                                void navigator.clipboard.writeText(
                                    Array.isArray(value)
                                        ? value.join(", ")
                                        : (value ?? "").toString(),
                                );
                            },
                        },
                        {
                            label: "Delete Property",
                            action: () => {
                                const { key } = contextMenu.payload;
                                onChange(
                                    serializeFrontmatterRaw(
                                        entries.filter(
                                            (entry) => entry.key !== key,
                                        ),
                                    ),
                                );
                            },
                            danger: true,
                        },
                    ]}
                />
            )}
        </div>
    );
}
