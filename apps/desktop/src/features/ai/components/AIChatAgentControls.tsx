import { useEffect, useRef, useState } from "react";
import type {
    AIConfigOption,
    AIModeOption,
    AIModelOption,
} from "../types";

interface AIChatAgentControlsProps {
    disabled?: boolean;
    modelId: string;
    modeId: string;
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

const REASONING_SUFFIX_REGEX = /\s+\((low|medium|high|xhigh)\)$/i;

function DropdownField({
    disabled = false,
    label,
    value,
    options,
    onChange,
}: DropdownFieldProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const selected = options.find((o) => o.value === value);

    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => {
                    if (!disabled) setOpen(!open);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    border: "none",
                    opacity: disabled ? 0.45 : 1,
                }}
                title={label}
                disabled={disabled}
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
            {open && (
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
                            onMouseEnter={(e) => {
                                if (!option.disabled)
                                    (e.currentTarget as HTMLElement).style.backgroundColor =
                                        "color-mix(in srgb, var(--text-primary) 8%, transparent)";
                            }}
                            onMouseLeave={(e) => {
                                (e.currentTarget as HTMLElement).style.backgroundColor =
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

function getModelBaseName(name: string) {
    return name.replace(REASONING_SUFFIX_REGEX, "");
}

function getModelReasoning(name: string) {
    const match = name.match(REASONING_SUFFIX_REGEX);
    return match?.[1]?.toLowerCase() ?? null;
}

function prettifyModelLabel(value: string) {
    return value
        .split("-")
        .map((part) => {
            if (/^gpt$/i.test(part)) return part.toUpperCase();
            if (/^\d+(\.\d+)?$/.test(part)) return part;
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join("-");
}

export function AIChatAgentControls({
    disabled = false,
    modelId,
    modeId,
    models,
    modes,
    configOptions,
    onModelChange,
    onModeChange,
    onConfigOptionChange,
}: AIChatAgentControlsProps) {
    const visibleConfigOptions = configOptions.filter(
        (option) => option.category !== "mode" && option.category !== "model",
    );
    const reasoningOption = visibleConfigOptions.find(
        (option) => option.category === "reasoning",
    );
    const reasoningValue = reasoningOption?.value;
    const currentModel = models.find((model) => model.id === modelId) ?? null;
    const currentModelBase = currentModel
        ? getModelBaseName(currentModel.name)
        : modelId;
    const modelsByBaseName = new Map<string, AIModelOption[]>();
    for (const model of models) {
        const baseName = getModelBaseName(model.name);
        const variants = modelsByBaseName.get(baseName) ?? [];
        variants.push(model);
        modelsByBaseName.set(baseName, variants);
    }
    const modelBaseOptions = Array.from(
        new Map(
            models.map((model) => [
                getModelBaseName(model.name),
                {
                    value: getModelBaseName(model.name),
                    label: prettifyModelLabel(getModelBaseName(model.name)),
                    description: model.description,
                },
            ]),
        ).values(),
    );
    const orderedConfigOptions = visibleConfigOptions.sort((left, right) => {
        const rank = (option: AIConfigOption) =>
            option.category === "reasoning" ? 0 : 1;
        return rank(left) - rank(right);
    });

    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
            <DropdownField
                disabled={disabled}
                label="Mode"
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
                value={currentModelBase}
                options={modelBaseOptions}
                onChange={(baseName) => {
                    const variants = modelsByBaseName.get(baseName) ?? [];
                    const nextModel =
                        variants.find(
                            (model) =>
                                getModelReasoning(model.name) === reasoningValue,
                        ) ??
                        variants.find((model) => model.id === modelId) ??
                        variants[0];

                    if (nextModel) {
                        const nextReasoning = getModelReasoning(nextModel.name);
                        if (
                            reasoningOption &&
                            nextReasoning &&
                            nextReasoning !== reasoningValue &&
                            reasoningOption.options.some(
                                (option) => option.value === nextReasoning,
                            )
                        ) {
                            onConfigOptionChange(reasoningOption.id, nextReasoning);
                        }
                        onModelChange(nextModel.id);
                    }
                }}
            />
            {orderedConfigOptions.map((option) => (
                <DropdownField
                    key={option.id}
                    disabled={disabled}
                    label={option.label}
                    value={option.value}
                    options={option.options
                        .filter((item) => {
                            if (option.category !== "reasoning") return true;
                            const variants =
                                modelsByBaseName.get(currentModelBase) ?? [];
                            return variants.some(
                                (model) =>
                                    getModelReasoning(model.name) === item.value,
                            );
                        })
                        .map((item) => ({
                            value: item.value,
                            label: item.label,
                            description: item.description,
                        }))}
                    onChange={(v) => {
                        if (option.category === "reasoning") {
                            const variants =
                                modelsByBaseName.get(currentModelBase) ?? [];
                            const nextModel = variants.find(
                                (model) => getModelReasoning(model.name) === v,
                            );
                            if (nextModel && nextModel.id !== modelId) {
                                onModelChange(nextModel.id);
                            }
                        }
                        onConfigOptionChange(option.id, v);
                    }}
                />
            ))}
        </div>
    );
}
