import { useEffect, useMemo, useRef, useState } from "react";
import type { AIConfigOption, AIModeOption, AIModelOption } from "../types";

interface AIChatAgentControlsProps {
    disabled?: boolean;
    runtimeId?: string;
    modelId: string;
    modeId: string;
    effortsByModel?: Record<string, string[]>;
    models: AIModelOption[];
    modes: AIModeOption[];
    configOptions: AIConfigOption[];
    onModelChange: (modelId: string) => void;
    onModeChange: (modeId: string) => void;
    onConfigOptionChange: (optionId: string, value: string) => void;
}

interface DropdownOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
}

interface DropdownFieldProps {
    disabled?: boolean;
    label: string;
    value: string;
    options: DropdownOption[];
    searchable?: boolean;
    searchPlaceholder?: string;
    emptySearchMessage?: string;
    onChange: (value: string) => void;
}

function formatFallbackLabel(value: string) {
    if (value.trim().includes(" ")) {
        return value;
    }

    return value
        .replace(/_/g, " ")
        .split("-")
        .map((token) => {
            if (!token) return token;
            if (/^gpt$/i.test(token)) return "GPT";
            if (/^claude$/i.test(token)) return "Claude";
            if (/^\d+(\.\d+)?$/.test(token)) return token;
            if (/^[a-z]\d+$/i.test(token)) return token.toUpperCase();
            return token.charAt(0).toUpperCase() + token.slice(1);
        })
        .join(" ");
}

function DropdownField({
    disabled = false,
    label,
    value,
    options,
    searchable = false,
    searchPlaceholder = "Search…",
    emptySearchMessage = "No matches found.",
    onChange,
}: DropdownFieldProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const lastFocusedElementRef = useRef<HTMLElement | null>(null);
    const selected = options.find((option) => option.value === value);
    const isDisabled = disabled || options.length === 0;
    const rememberFocusedElement = () => {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
            lastFocusedElementRef.current = activeElement;
        }
    };
    const restoreFocusedElement = () => {
        const target = lastFocusedElementRef.current;
        if (!target?.isConnected) {
            return;
        }

        target.focus();
    };
    const closeDropdown = () => {
        setOpen(false);
        setQuery("");
    };
    const filteredOptions = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!searchable || !normalizedQuery) {
            return options;
        }

        return options.filter((option) => {
            const label = option.label.toLowerCase();
            const rawValue = option.value.toLowerCase();
            const description = option.description?.toLowerCase() ?? "";
            return (
                label.includes(normalizedQuery) ||
                rawValue.includes(normalizedQuery) ||
                description.includes(normalizedQuery)
            );
        });
    }, [options, query, searchable]);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (ref.current?.contains(event.target as Node)) return;
            closeDropdown();
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    useEffect(() => {
        if (!open) return;

        if (searchable) {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
        }
    }, [open, searchable]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onMouseDown={(event) => {
                    if (isDisabled) return;
                    rememberFocusedElement();
                    // Keep the composer focused during pointer interactions so
                    // Cmd+Enter continues to submit immediately after a change.
                    event.preventDefault();
                }}
                onClick={() => {
                    if (isDisabled) return;
                    if (open) {
                        closeDropdown();
                        return;
                    }
                    rememberFocusedElement();
                    setOpen(true);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    border: "none",
                    opacity: isDisabled ? 0.45 : 1,
                    transition: "background-color 100ms ease, color 100ms ease",
                }}
                onMouseEnter={(e) => {
                    if (isDisabled) return;
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)";
                    e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                    if (isDisabled) return;
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--text-secondary)";
                }}
                title={label}
                disabled={isDisabled}
            >
                <span className="truncate">{selected?.label ?? value}</span>
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                        opacity: 0.5,
                        transform: open ? "rotate(180deg)" : "none",
                        transition: "transform 0.1s ease",
                    }}
                >
                    <path d="M2.5 4L5 6.5L7.5 4" />
                </svg>
            </button>
            {open && options.length > 0 && (
                <div
                    className="absolute bottom-full left-0 z-50 mb-1 min-w-35 overflow-hidden rounded-lg py-1"
                    style={{
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                        maxHeight: searchable ? 320 : undefined,
                        display: searchable ? "flex" : undefined,
                        flexDirection: searchable ? "column" : undefined,
                    }}
                >
                    {searchable && (
                        <div
                            className="px-1.5 pb-1"
                            style={{
                                borderBottom: "1px solid var(--border)",
                            }}
                        >
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={query}
                                onChange={(event) => {
                                    setQuery(event.target.value);
                                }}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                }}
                                placeholder={searchPlaceholder}
                                aria-label={`${label} search`}
                                className="mt-0.5 w-full rounded-md px-1.5 py-0.5 text-[8px]"
                                style={{
                                    color: "var(--text-primary)",
                                    backgroundColor: "var(--bg-primary)",
                                    border: "1px solid var(--border)",
                                    outline: "none",
                                    minHeight: 22,
                                    lineHeight: 1.1,
                                }}
                            />
                        </div>
                    )}
                    <div
                        style={{
                            maxHeight: searchable ? 240 : undefined,
                            overflowY: searchable ? "auto" : undefined,
                            flex: searchable ? "1 1 auto" : undefined,
                        }}
                    >
                        {filteredOptions.length === 0 ? (
                            <div
                                className="px-3 py-2 text-xs"
                                style={{
                                    color: "var(--text-secondary)",
                                }}
                            >
                                {emptySearchMessage}
                            </div>
                        ) : (
                            filteredOptions.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    disabled={option.disabled}
                                    onMouseDown={(event) => {
                                        if (option.disabled) {
                                            return;
                                        }

                                        event.preventDefault();
                                    }}
                                    onClick={() => {
                                        onChange(option.value);
                                        closeDropdown();
                                        restoreFocusedElement();
                                    }}
                                    className="flex w-full items-center px-3 py-1.5 text-left text-xs"
                                    style={{
                                        color:
                                            option.value === value
                                                ? "var(--accent)"
                                                : option.disabled
                                                  ? "var(--text-secondary)"
                                                  : "var(--text-primary)",
                                        backgroundColor: "transparent",
                                        border: "none",
                                        opacity: option.disabled ? 0.4 : 1,
                                        transition:
                                            "background-color 80ms ease",
                                    }}
                                    onMouseEnter={(event) => {
                                        if (!option.disabled) {
                                            event.currentTarget.style.backgroundColor =
                                                "var(--bg-tertiary)";
                                        }
                                    }}
                                    onMouseLeave={(event) => {
                                        event.currentTarget.style.backgroundColor =
                                            "transparent";
                                    }}
                                >
                                    {option.label}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function mapConfigOption(option: AIConfigOption): DropdownOption[] {
    return option.options.map((item) => ({
        value: item.value,
        label: item.label,
        description: item.description,
    }));
}

function filterConfigOptions(
    option: AIConfigOption,
    modelId: string,
    effortsByModel?: Record<string, string[]>,
) {
    if (option.category !== "reasoning") {
        return mapConfigOption(option);
    }

    const supportedEfforts = effortsByModel?.[modelId];
    const hasModelEffortMetadata =
        effortsByModel &&
        Object.prototype.hasOwnProperty.call(effortsByModel, modelId);
    const items = hasModelEffortMetadata
        ? option.options.filter((item) =>
              supportedEfforts?.includes(item.value),
          )
        : option.options;

    return items.map((item) => ({
        value: item.value,
        label: item.label,
        description: item.description,
    }));
}

export function AIChatAgentControls({
    disabled = false,
    runtimeId,
    modelId,
    modeId,
    effortsByModel,
    models,
    modes,
    configOptions,
    onModelChange,
    onModeChange,
    onConfigOptionChange,
}: AIChatAgentControlsProps) {
    const modelConfig = useMemo(
        () => configOptions.find((option) => option.category === "model"),
        [configOptions],
    );
    const selectedModelId = modelConfig?.value ?? modelId;
    const extraConfigs = useMemo(
        () =>
            [...configOptions]
                .filter(
                    (option) =>
                        option.category !== "mode" &&
                        option.category !== "model",
                )
                .sort((left, right) => {
                    const rank = (option: AIConfigOption) =>
                        option.category === "reasoning" ? 0 : 1;
                    return rank(left) - rank(right);
                }),
        [configOptions],
    );
    const visibleExtraConfigs = useMemo(
        () =>
            extraConfigs
                .map((option) => ({
                    option,
                    options: filterConfigOptions(
                        option,
                        selectedModelId,
                        effortsByModel,
                    ),
                }))
                .filter(({ options }) => options.length > 0),
        [effortsByModel, extraConfigs, selectedModelId],
    );

    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
            <DropdownField
                disabled={disabled}
                label="Approval Preset"
                value={modeId}
                options={modes.map((mode) => ({
                    value: mode.id,
                    label: formatFallbackLabel(mode.name),
                    description: mode.description,
                    disabled: mode.disabled,
                }))}
                onChange={onModeChange}
            />
            <DropdownField
                disabled={disabled}
                label="Model"
                value={selectedModelId}
                searchable={runtimeId === "kilo-acp"}
                searchPlaceholder="Select a model..."
                emptySearchMessage="No Kilo models match that search."
                options={
                    modelConfig
                        ? mapConfigOption(modelConfig)
                        : models.map((model) => ({
                              value: model.id,
                              label: formatFallbackLabel(model.name),
                              description: model.description,
                          }))
                }
                onChange={(value) =>
                    modelConfig
                        ? onConfigOptionChange(modelConfig.id, value)
                        : onModelChange(value)
                }
            />
            {visibleExtraConfigs.map(({ option, options }) => (
                <DropdownField
                    key={option.id}
                    disabled={disabled}
                    label={option.label}
                    value={option.value}
                    options={options}
                    onChange={(value) => onConfigOptionChange(option.id, value)}
                />
            ))}
        </div>
    );
}
