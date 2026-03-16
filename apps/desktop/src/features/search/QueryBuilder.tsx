import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
    type Operator,
    type SearchToken,
    type ParsedQuery,
    parseQuery,
} from "./queryParser";

type Field = "title" | Operator;
type Condition = "contains" | "not_contains" | "regex" | "exact";
type BoolMode = "all" | "any";

interface FilterRow {
    id: string;
    field: Field;
    condition: Condition;
    value: string;
    propertyKey: string;
}

const FIELD_OPTIONS: { value: Field; label: string }[] = [
    { value: "title", label: "Title / Path" },
    { value: "file", label: "Filename" },
    { value: "path", label: "Path" },
    { value: "tag", label: "Tag" },
    { value: "content", label: "Content" },
    { value: "line", label: "Line" },
    { value: "section", label: "Section" },
    { value: "property", label: "Property" },
];

const CONDITION_OPTIONS: { value: Condition; label: string }[] = [
    { value: "contains", label: "contains" },
    { value: "not_contains", label: "does not contain" },
    { value: "regex", label: "matches regex" },
    { value: "exact", label: "is exactly" },
];

function makeRow(): FilterRow {
    return {
        id: crypto.randomUUID(),
        field: "content",
        condition: "contains",
        value: "",
        propertyKey: "",
    };
}

function rowsToQuery(rows: FilterRow[], boolMode: BoolMode): string {
    const parts: string[] = [];

    for (const row of rows) {
        if (!row.value.trim()) continue;

        let term = "";
        const negated = row.condition === "not_contains";
        const isRegex = row.condition === "regex";
        const needsQuote = row.value.includes(" ") && !isRegex;
        const val = isRegex
            ? `/${row.value}/`
            : needsQuote
              ? `"${row.value}"`
              : row.value;

        if (row.field === "property") {
            const key = row.propertyKey.trim() || "key";
            term = `${negated ? "-" : ""}[${key}:${row.value}]`;
        } else if (row.field === "title") {
            term = `${negated ? "-" : ""}${val}`;
        } else {
            term = `${negated ? "-" : ""}${row.field}:${val}`;
        }

        parts.push(term);
    }

    return parts.join(boolMode === "any" ? " OR " : " ");
}

function parsedToRows(parsed: ParsedQuery): {
    rows: FilterRow[];
    boolMode: BoolMode;
} {
    const rows: FilterRow[] = [];
    let hasOr = false;

    const tokenToRow = (t: SearchToken): FilterRow => {
        const condition: Condition = t.isRegex
            ? "regex"
            : t.negated
              ? "not_contains"
              : "contains";

        const field: Field = t.operator ?? "title";

        return {
            id: crypto.randomUUID(),
            field,
            condition,
            value: t.value,
            propertyKey: t.propertyKey ?? "",
        };
    };

    for (const token of parsed.tokens) {
        if (token.orGroup) {
            hasOr = true;
            for (const member of token.orGroup) {
                rows.push(tokenToRow(member));
            }
        } else {
            rows.push(tokenToRow(token));
        }
    }

    return {
        rows: rows.length > 0 ? rows : [makeRow()],
        boolMode: hasOr ? "any" : "all",
    };
}

// ── Custom Dropdown ─────────────────────────────────────

export interface DropdownOption<T extends string> {
    value: T;
    label: string;
}

export function Dropdown<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: DropdownOption<T>[];
    onChange: (value: T) => void;
}) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ top: 0, left: 0 });

    const selected = options.find((o) => o.value === value);

    useEffect(() => {
        if (!open) return;
        const trigger = triggerRef.current;
        if (trigger) {
            const rect = trigger.getBoundingClientRect();
            setPos({ top: rect.bottom + 2, left: rect.left });
        }

        const handleDown = (e: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node) &&
                triggerRef.current &&
                !triggerRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open]);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="shrink-0 flex items-center gap-1 px-1.5 rounded text-[11px] cursor-pointer transition-colors"
                style={{
                    height: 26,
                    backgroundColor: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
                }}
                onMouseEnter={(e) => {
                    if (!open)
                        e.currentTarget.style.borderColor = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                    if (!open)
                        e.currentTarget.style.borderColor = "var(--border)";
                }}
            >
                <span className="truncate">{selected?.label ?? value}</span>
                <svg
                    width="8"
                    height="8"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="shrink-0 opacity-50"
                >
                    <path d="M4 6l4 4 4-4" />
                </svg>
            </button>
            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        style={{
                            position: "fixed",
                            top: pos.top,
                            left: pos.left,
                            zIndex: 10000,
                            display: "flex",
                            flexDirection: "column",
                            width: "fit-content",
                            minWidth: 120,
                            padding: 4,
                            borderRadius: 8,
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                        }}
                    >
                        {options.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => {
                                    onChange(opt.value);
                                    setOpen(false);
                                }}
                                className="text-left px-3 py-1.5 text-[11px] rounded"
                                style={{
                                    color:
                                        opt.value === value
                                            ? "var(--accent)"
                                            : "var(--text-primary)",
                                    background: "transparent",
                                    whiteSpace: "nowrap",
                                    fontWeight: opt.value === value ? 600 : 400,
                                }}
                                onMouseEnter={(e) =>
                                    (e.currentTarget.style.backgroundColor =
                                        "var(--bg-tertiary)")
                                }
                                onMouseLeave={(e) =>
                                    (e.currentTarget.style.backgroundColor =
                                        "transparent")
                                }
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>,
                    document.body,
                )}
        </>
    );
}

// ── QueryBuilder ────────────────────────────────────────

interface QueryBuilderProps {
    query: string;
    onQueryChange: (query: string) => void;
}

export function QueryBuilder({ query, onQueryChange }: QueryBuilderProps) {
    const parsed = parseQuery(query);
    const initial = parsedToRows(parsed);
    const [builderState, setBuilderState] = useState(() => ({
        sourceQuery: query,
        rows: initial.rows,
        boolMode: initial.boolMode,
    }));
    const [collapsed, setCollapsed] = useState(false);
    const [lastEmittedQuery, setLastEmittedQuery] = useState(query);
    const externalState =
        query === lastEmittedQuery || query === builderState.sourceQuery
            ? builderState
            : (() => {
                  const nextParsed = parseQuery(query);
                  const { rows, boolMode } = parsedToRows(nextParsed);
                  return {
                      sourceQuery: query,
                      rows,
                      boolMode,
                  };
              })();
    const rows = externalState.rows;
    const boolMode = externalState.boolMode;

    const emitQuery = useCallback(
        (newRows: FilterRow[], mode: BoolMode) => {
            const q = rowsToQuery(newRows, mode);
            setLastEmittedQuery(q);
            setBuilderState({
                sourceQuery: q,
                rows: newRows,
                boolMode: mode,
            });
            onQueryChange(q);
        },
        [onQueryChange],
    );

    const updateRow = (id: string, patch: Partial<FilterRow>) => {
        const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
        emitQuery(next, boolMode);
    };

    const removeRow = (id: string) => {
        const next = rows.filter((r) => r.id !== id);
        const final = next.length > 0 ? next : [makeRow()];
        emitQuery(final, boolMode);
    };

    const addRow = () => {
        const next = [...rows, makeRow()];
        setBuilderState({
            sourceQuery: lastEmittedQuery,
            rows: next,
            boolMode,
        });
    };

    const handleBoolChange = (mode: BoolMode) => {
        emitQuery(rows, mode);
    };

    const inputStyle = {
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        border: "1px solid var(--border)",
    };

    return (
        <div
            className="rounded-lg overflow-hidden"
            style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2"
                style={{
                    borderBottom: collapsed
                        ? "none"
                        : "1px solid var(--border)",
                }}
            >
                <span
                    className="text-[11px] font-medium uppercase tracking-wider"
                    style={{ color: "var(--text-secondary)" }}
                >
                    Query Builder
                </span>
                <div className="flex items-center gap-1.5">
                    {!collapsed && (
                        <>
                            <span
                                className="text-[11px]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Match
                            </span>
                            <button
                                onClick={() => handleBoolChange("all")}
                                className="px-2 py-0.5 rounded text-[11px] transition-colors"
                                style={{
                                    backgroundColor:
                                        boolMode === "all"
                                            ? "var(--accent)"
                                            : "var(--bg-primary)",
                                    color:
                                        boolMode === "all"
                                            ? "#fff"
                                            : "var(--text-secondary)",
                                    border: `1px solid ${boolMode === "all" ? "var(--accent)" : "var(--border)"}`,
                                }}
                            >
                                ALL
                            </button>
                            <button
                                onClick={() => handleBoolChange("any")}
                                className="px-2 py-0.5 rounded text-[11px] transition-colors"
                                style={{
                                    backgroundColor:
                                        boolMode === "any"
                                            ? "var(--accent)"
                                            : "var(--bg-primary)",
                                    color:
                                        boolMode === "any"
                                            ? "#fff"
                                            : "var(--text-secondary)",
                                    border: `1px solid ${boolMode === "any" ? "var(--accent)" : "var(--border)"}`,
                                }}
                            >
                                ANY
                            </button>
                        </>
                    )}
                    <button
                        onClick={() => setCollapsed((v) => !v)}
                        title={collapsed ? "Expand" : "Collapse"}
                        className="opacity-40 hover:opacity-100 transition-opacity p-0.5 rounded"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            style={{
                                transform: collapsed
                                    ? "rotate(-90deg)"
                                    : "rotate(0deg)",
                                transition: "transform 150ms",
                            }}
                        >
                            <path d="M4 6l4 4 4-4" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Filter rows */}
            {!collapsed && (
                <div className="px-3 py-2 flex flex-col gap-2">
                    {rows.map((row, idx) => (
                        <div key={row.id} className="flex items-center gap-2">
                            {/* Row number */}
                            <span
                                className="text-[10px] font-mono shrink-0"
                                style={{
                                    color: "var(--text-secondary)",
                                    opacity: 0.5,
                                    width: 14,
                                    textAlign: "right",
                                }}
                            >
                                {idx + 1}
                            </span>

                            {/* Field selector */}
                            <Dropdown
                                value={row.field}
                                options={FIELD_OPTIONS}
                                onChange={(v) =>
                                    updateRow(row.id, { field: v })
                                }
                            />

                            {/* Property key (only for property field) */}
                            {row.field === "property" && (
                                <input
                                    type="text"
                                    value={row.propertyKey}
                                    onChange={(e) =>
                                        updateRow(row.id, {
                                            propertyKey: e.target.value,
                                        })
                                    }
                                    placeholder="key"
                                    className="shrink-0 px-1.5 rounded text-[11px] outline-none"
                                    style={{
                                        ...inputStyle,
                                        height: 26,
                                        width: 60,
                                    }}
                                    spellCheck={false}
                                />
                            )}

                            {/* Condition selector */}
                            <Dropdown
                                value={row.condition}
                                options={CONDITION_OPTIONS}
                                onChange={(v) =>
                                    updateRow(row.id, { condition: v })
                                }
                            />

                            {/* Value input */}
                            <input
                                type="text"
                                value={row.value}
                                onChange={(e) =>
                                    updateRow(row.id, { value: e.target.value })
                                }
                                placeholder="value..."
                                className="flex-1 min-w-0 px-2 rounded text-[11px] outline-none"
                                style={{ ...inputStyle, height: 26 }}
                                spellCheck={false}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        emitQuery(rows, boolMode);
                                    }
                                }}
                            />

                            {/* Remove button */}
                            <button
                                onClick={() => removeRow(row.id)}
                                className="shrink-0 p-1 rounded opacity-40 hover:opacity-100 transition-opacity"
                                style={{ color: "var(--text-secondary)" }}
                                title="Remove filter"
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                >
                                    <path d="M4 4l8 8M4 12l8-8" />
                                </svg>
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Footer */}
            {!collapsed && (
                <div className="px-3 pb-2.5 flex items-center justify-between">
                    <button
                        onClick={addRow}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors"
                        style={{
                            color: "var(--accent)",
                            backgroundColor: "transparent",
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                                "var(--bg-tertiary)")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor =
                                "transparent")
                        }
                    >
                        <svg
                            width="11"
                            height="11"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        >
                            <path d="M8 3v10M3 8h10" />
                        </svg>
                        Add filter
                    </button>
                    <button
                        onClick={() => {
                            const fresh = [makeRow()];
                            setBuilderState({
                                sourceQuery: "",
                                rows: fresh,
                                boolMode,
                            });
                            setLastEmittedQuery("");
                            onQueryChange("");
                        }}
                        className="px-2 py-1 rounded text-[11px] transition-colors"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor =
                                "var(--bg-tertiary)")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor =
                                "transparent")
                        }
                    >
                        Clear all
                    </button>
                </div>
            )}
        </div>
    );
}
