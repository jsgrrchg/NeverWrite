import { useEffect, useMemo, useRef, useState } from "react";
import type { AIConfigOption, AIModeOption, AIModelOption } from "../types";

interface AIChatAgentControlsProps {
    disabled?: boolean;
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
    onChange: (value: string) => void;
}

function DropdownField({
    disabled = false,
    label,
    value,
    options,
    onChange,
}: DropdownFieldProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const selected = options.find((option) => option.value === value);
    const isDisabled = disabled || options.length === 0;

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (ref.current?.contains(event.target as Node)) return;
            setOpen(false);
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => {
                    if (!isDisabled) setOpen((current) => !current);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    border: "none",
                    opacity: isDisabled ? 0.45 : 1,
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
                    className="absolute bottom-full left-0 z-50 mb-1 min-w-[140px] overflow-hidden rounded-lg py-1"
                    style={{
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                    }}
                >
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            disabled={option.disabled}
                            onClick={() => {
                                onChange(option.value);
                                setOpen(false);
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
                            }}
                            onMouseEnter={(event) => {
                                if (!option.disabled) {
                                    event.currentTarget.style.backgroundColor =
                                        "color-mix(in srgb, var(--text-primary) 8%, transparent)";
                                }
                            }}
                            onMouseLeave={(event) => {
                                event.currentTarget.style.backgroundColor =
                                    "transparent";
                            }}
                        >
                            {option.label}
                        </button>
                    ))}
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
    const items =
        supportedEfforts && supportedEfforts.length > 0
            ? option.options.filter((item) =>
                  supportedEfforts.includes(item.value),
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

    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
            <DropdownField
                disabled={disabled}
                label="Approval Preset"
                value={modeId}
                options={modes.map((mode) => ({
                    value: mode.id,
                    label: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                }))}
                onChange={onModeChange}
            />
            <DropdownField
                disabled={disabled}
                label="Model"
                value={selectedModelId}
                options={
                    modelConfig
                        ? mapConfigOption(modelConfig)
                        : models.map((model) => ({
                              value: model.id,
                              label: model.name,
                              description: model.description,
                          }))
                }
                onChange={(value) =>
                    modelConfig
                        ? onConfigOptionChange(modelConfig.id, value)
                        : onModelChange(value)
                }
            />
            {extraConfigs.map((option) => (
                <DropdownField
                    key={option.id}
                    disabled={disabled}
                    label={option.label}
                    value={option.value}
                    options={filterConfigOptions(
                        option,
                        selectedModelId,
                        effortsByModel,
                    )}
                    onChange={(value) => onConfigOptionChange(option.id, value)}
                />
            ))}
        </div>
    );
}
