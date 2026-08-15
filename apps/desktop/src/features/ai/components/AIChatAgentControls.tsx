import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ConversationProviderPickerOption } from "../conversationPickerModel";
import type { AIConfigOption, AIModeOption, AIModelOption } from "../types";
import { AIProviderModelPicker } from "./AIProviderModelPicker";
import { useAnchoredChatMenuPosition } from "./useAnchoredChatMenuPosition";

interface AIChatAgentControlsProps {
  disabled?: boolean;
  conversationStarted?: boolean;
  runtimeId?: string;
  lockIncompatibleModelSwitches?: boolean;
  modelId: string;
  modeId: string;
  effortsByModel?: Record<string, string[]>;
  models: AIModelOption[];
  modes: AIModeOption[];
  configOptions: AIConfigOption[];
  providers?: ConversationProviderPickerOption[];
  onProviderModelChange?: (runtimeId: string, modelId: string) => void;
  onProviderActivate?: (runtimeId: string) => void | Promise<void>;
  onModelChange: (modelId: string) => void;
  onModeChange: (modeId: string) => void;
  onConfigOptionChange: (optionId: string, value: string) => void;
}

interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  agentType?: string;
  disabled?: boolean;
  configOptionId?: string;
  groupLabel?: string;
  isDefault?: boolean;
  selected?: boolean;
}

interface DropdownFieldProps {
  disabled?: boolean;
  label: string;
  value: string;
  options: DropdownOption[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchMessage?: string;
  displayValue?: string;
  menuMinWidth?: number;
  leadingIcon?: ReactNode;
  compact?: boolean;
  compactLabel?: string;
  trailingIcon?: ReactNode;
  onChange?: (value: string) => void;
  onOptionChange?: (value: string, option: DropdownOption) => void;
}

interface TraitMenuSection {
  kind: "reasoning" | "service_tier";
  optionId: string;
  label: string;
  value: string;
  options: DropdownOption[];
  defaultValues: string[];
}

const SEARCHABLE_MODEL_RUNTIME_IDS = new Set(["kilo-acp", "opencode-acp"]);
const GROK_RUNTIME_ID = "grok-acp";
const CODEX_FULL_ACCESS_MODE_ID = "full-access";
const COMPOSER_MODE_OPTION_ID = "composer-mode";

function shouldUseSearchableModelMenu(runtimeId?: string) {
  return runtimeId !== undefined && SEARCHABLE_MODEL_RUNTIME_IDS.has(runtimeId);
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

function modelDisplayLabel(label: string, modelId: string) {
  return label.trim() || formatFallbackLabel(modelId);
}

function DropdownField({
  disabled = false,
  label,
  value,
  options,
  searchable = false,
  searchPlaceholder = "Search…",
  emptySearchMessage = "No matches found.",
  displayValue: displayValueOverride,
  menuMinWidth,
  leadingIcon,
  compact = false,
  compactLabel,
  trailingIcon,
  onChange,
  onOptionChange,
}: DropdownFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const selected = options.find(
    (option) => option.selected ?? option.value === value,
  );
  const displayValue =
    displayValueOverride ??
    selected?.label ??
    (value.trim() ? formatFallbackLabel(value) : label);
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
  const menuPosition = useAnchoredChatMenuPosition(ref, menuRef, open);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (
        ref.current?.contains(event.target as Node) ||
        menuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
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
        aria-label={compact ? label : undefined}
        className={`nw-control-trigger flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs${
          compact
            ? compactLabel
              ? " h-7"
              : " h-7 w-7 justify-center px-0"
            : ""
        }`}
        data-open={open ? "true" : undefined}
        style={{
          color: "var(--text-secondary)",
          backgroundColor: "transparent",
          border: "none",
          opacity: isDisabled ? 0.45 : 1,
        }}
        title={label}
        disabled={isDisabled}
      >
        {leadingIcon}
        {compact ? (
          compactLabel ? <span className="truncate">{compactLabel}</span> : null
        ) : (
          <span className="truncate">{displayValue}</span>
        )}
        {compact ? trailingIcon : null}
        {compact ? null : (
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
        )}
      </button>
      {open && options.length > 0
        ? createPortal(
        <div
          ref={menuRef}
          className="nw-chat-glass-menu fixed z-50 min-w-35 overflow-hidden rounded-lg py-1"
          style={{
            border: "1px solid var(--border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            left: menuPosition?.left ?? 8,
            top: menuPosition?.top ?? 8,
            visibility: menuPosition ? "visible" : "hidden",
            minWidth: menuMinWidth,
            maxHeight: searchable ? 320 : undefined,
            display: searchable ? "flex" : undefined,
            flexDirection: searchable ? "column" : undefined,
          }}
        >
          {searchable && (
            <div
              className="mx-1 mb-1 flex items-center gap-1.5 rounded-md"
              style={{
                backgroundColor: "var(--bg-primary)",
                border: "1px solid var(--border)",
                height: 24,
                padding: "0 7px",
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                style={{ opacity: 0.4, flexShrink: 0 }}
                aria-hidden="true"
              >
                <circle
                  cx="7"
                  cy="7"
                  r="5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="m13 13-2.5-2.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
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
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                style={{
                  color: "var(--text-primary)",
                  border: "none",
                  fontFamily: "inherit",
                  // The global `input { font: inherit }` reset in
                  // index.css lives outside Tailwind's cascade
                  // layers, so it always wins over the `text-xs`
                  // utility here regardless of specificity. Pin
                  // the size/line-height inline to match the
                  // option rows, which aren't affected (buttons
                  // aren't targeted by that reset).
                  fontSize: "0.75rem",
                  lineHeight: "calc(1 / 0.75)",
                }}
              />
              <span
                className="shrink-0 font-mono text-[9px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {filteredOptions.length}/{options.length}
              </span>
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
              filteredOptions.map((option, index) => (
                <div
                  key={`${option.groupLabel ?? ""}:${option.configOptionId ?? ""}:${option.value}`}
                  style={{
                    borderTop:
                      option.groupLabel &&
                      index > 0 &&
                      filteredOptions[index - 1]?.groupLabel !==
                        option.groupLabel
                        ? "1px solid var(--border)"
                        : undefined,
                  }}
                >
                  {option.groupLabel &&
                  (index === 0 ||
                    filteredOptions[index - 1]?.groupLabel !==
                      option.groupLabel) ? (
                    <div
                      className="px-3 pb-1 pt-1.5 text-[10px] font-medium"
                      style={{
                        color: "var(--text-secondary)",
                      }}
                    >
                      {option.groupLabel}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    disabled={option.disabled}
                    title={option.description}
                    onMouseDown={(event) => {
                      if (option.disabled) {
                        return;
                      }

                      event.preventDefault();
                    }}
                    onClick={() => {
                      if (onOptionChange) {
                        onOptionChange(option.value, option);
                      } else {
                        onChange?.(option.value);
                      }
                      closeDropdown();
                      restoreFocusedElement();
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs"
                    style={{
                      color:
                        option.selected === true
                          ? "var(--text-primary)"
                          : option.value === value
                            ? "var(--accent)"
                            : option.disabled
                              ? "var(--text-secondary)"
                              : "var(--text-primary)",
                      backgroundColor:
                        option.selected === true
                          ? "var(--bg-tertiary)"
                          : "transparent",
                      border: "none",
                      opacity: option.disabled ? 0.4 : 1,
                      transition: "background-color 80ms ease",
                    }}
                    onMouseEnter={(event) => {
                      if (!option.disabled) {
                        event.currentTarget.style.backgroundColor =
                          "var(--bg-tertiary)";
                      }
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.backgroundColor =
                        option.selected === true
                          ? "var(--bg-tertiary)"
                          : "transparent";
                    }}
                  >
                    <span className="truncate">{option.label}</span>
                    {option.isDefault ? (
                      <span
                        className="ml-3 shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-semibold leading-none"
                        style={{
                          backgroundColor: "var(--bg-primary)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        Default
                      </span>
                    ) : null}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>,
        document.body,
        )
        : null}
    </div>
  );
}

function isFastServiceTierValue(value: string) {
  return ["fast", "on", "priority"].includes(normalizeConfigOptionId(value));
}

function FastModeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="currentColor"
      height="11"
      viewBox="0 0 16 16"
      width="11"
    >
      <path d="M9.35 1.25 3.4 8.45h3.75l-.5 6.3 5.95-7.2H8.85l.5-6.3Z" />
    </svg>
  );
}

function ComposerOptionsIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="16"
      viewBox="0 0 16 16"
      width="16"
    >
      <circle cx="3" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="13" cy="8" r="1.25" />
    </svg>
  );
}

function PermissionModeIcon({ fullAccess }: { fullAccess: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 opacity-70"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
    >
      <rect
        height="8"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.35"
        width="10"
        x="3"
        y="6.5"
      />
      <path
        d={
          fullAccess
            ? "M5.25 6.5V5a2.75 2.75 0 0 1 5.05-1.51"
            : "M5.25 6.5V5a2.75 2.75 0 0 1 5.5 0v1.5"
        }
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function ControlSeparator() {
  return (
    <span
      aria-hidden="true"
      className="mx-0.5 h-4 w-px"
      style={{ backgroundColor: "var(--border)" }}
    />
  );
}

function mapConfigOption(option: AIConfigOption): DropdownOption[] {
  return option.options.map((item) => ({
    value: item.value,
    label: item.label,
    description: item.description,
    agentType: item.agentType,
  }));
}

function applyGrokModelSwitchLock(
  runtimeId: string | undefined,
  selectedModelId: string,
  options: DropdownOption[],
  lockIncompatibleModelSwitches: boolean,
): DropdownOption[] {
  if (
    runtimeId !== GROK_RUNTIME_ID ||
    !lockIncompatibleModelSwitches ||
    !selectedModelId
  ) {
    return options;
  }

  const selectedAgentType = options.find(
    (option) => option.value === selectedModelId,
  )?.agentType;
  if (!selectedAgentType) {
    return options;
  }

  return options.map((option) => {
    if (
      option.value === selectedModelId ||
      !option.agentType ||
      option.agentType === selectedAgentType
    ) {
      return option;
    }

    return {
      ...option,
      disabled: true,
      description: option.description
        ? `${option.description} Start a new Grok chat to switch to this model.`
        : "Start a new Grok chat to switch to this model.",
    };
  });
}

function isDuplicateThoughtLevelMode(
  option: AIConfigOption,
  modes: AIModeOption[],
  modeId: string,
) {
  if (
    option.category !== "reasoning" ||
    option.id.replace(/[^a-z0-9]/gi, "").toLowerCase() !== "thoughtlevel" ||
    option.value !== modeId ||
    modes.length === 0 ||
    modes.some((mode) => mode.disabled)
  ) {
    return false;
  }

  const modeIds = new Set(modes.map((mode) => mode.id));
  const optionValues = new Set(option.options.map((item) => item.value));
  return (
    modeIds.size === modes.length &&
    optionValues.size === option.options.length &&
    modeIds.size === optionValues.size &&
    [...modeIds].every((modeId) => optionValues.has(modeId))
  );
}

function normalizeConfigOptionId(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function configPresentationCategory(
  option: AIConfigOption,
) {
  if (option.category === "reasoning") {
    return "reasoning" as const;
  }
  if (option.category === "service_tier") {
    return "service_tier" as const;
  }

  const normalizedId = normalizeConfigOptionId(option.id);
  if (
    normalizedId === "servicetier" ||
    normalizedId === "fastmode"
  ) {
    return "service_tier" as const;
  }

  return "other" as const;
}

function normalizeServiceTierOptions(
  options: DropdownOption[],
  description?: string,
) {
  return options.map((item) => {
    const value = normalizeConfigOptionId(item.value);
    if (["off", "default", "standard", "normal"].includes(value)) {
      return { ...item, label: "Standard" };
    }
    if (["fast", "on", "priority"].includes(value)) {
      return {
        ...item,
        label: "Fast",
        description: item.description ?? description,
      };
    }
    return item;
  });
}

function defaultServiceTierValues(options: DropdownOption[]) {
  return options
    .filter((item) =>
      ["off", "default", "standard", "normal"].includes(
        normalizeConfigOptionId(item.value),
      ),
    )
    .map((item) => item.value);
}

export function AIChatAgentControls({
  disabled = false,
  conversationStarted = false,
  runtimeId,
  lockIncompatibleModelSwitches = false,
  modelId,
  modeId,
  models,
  modes,
  configOptions,
  providers = [],
  onProviderModelChange,
  onProviderActivate,
  onModelChange,
  onModeChange,
  onConfigOptionChange,
}: AIChatAgentControlsProps) {
  const modelConfig = useMemo(
    () => configOptions.find((option) => option.category === "model"),
    [configOptions],
  );
  const modelOptions = useMemo(
    () =>
      modelConfig
        ? mapConfigOption(modelConfig)
        : models.map((model) => ({
            value: model.id,
            label: modelDisplayLabel(model.name, model.id),
            description: model.description,
            agentType: model.agentType,
          })),
    [modelConfig, models],
  );
  const selectedModelId = modelConfig?.value ?? modelId;
  const lockedModelOptions = useMemo(
    () =>
      applyGrokModelSwitchLock(
        runtimeId,
        selectedModelId,
        modelOptions,
        lockIncompatibleModelSwitches,
      ),
    [lockIncompatibleModelSwitches, modelOptions, runtimeId, selectedModelId],
  );
  const providerPickerOptions = useMemo(
    () =>
      providers.map((provider) => ({
        ...provider,
        models:
          provider.runtimeId === runtimeId && lockedModelOptions.length > 0
            ? lockedModelOptions.map((model) => ({
                modelId: model.value,
                label: modelDisplayLabel(model.label, model.value),
                description: model.description,
                disabledReason: model.disabled
                  ? (model.description ?? "This model is unavailable.")
                  : null,
              }))
            : provider.models.map((model) => ({
                ...model,
                label: modelDisplayLabel(model.label, model.modelId),
              })),
      })),
    [lockedModelOptions, providers, runtimeId],
  );
  const extraConfigs = useMemo(
    () =>
      [...configOptions]
        .filter(
          (option) =>
            option.category !== "mode" &&
            option.category !== "model" &&
            !isDuplicateThoughtLevelMode(option, modes, modeId),
        )
        .sort((left, right) => {
          const rank = (option: AIConfigOption) =>
            option.category === "reasoning" ? 0 : 1;
          return rank(left) - rank(right);
        }),
    [configOptions, modeId, modes],
  );
  const visibleConfigs = useMemo(
    () =>
      extraConfigs
        .map((option) => ({
          option,
          presentationCategory: configPresentationCategory(option),
          // Session config options are the ACP's authoritative view
          // for the selected model. `effortsByModel` is discovery
          // metadata and can be empty or stale during a handoff.
          options: mapConfigOption(option),
        }))
        .filter(({ options }) => options.length > 0),
    [extraConfigs],
  );
  const traitSections = useMemo<TraitMenuSection[]>(() => {
    // Reasoning effort and service tier are separate ACP options, but they
    // belong to one compact composer control. Keep their option ids intact so
    // selecting an item still updates the provider-owned setting directly.
    const sections = visibleConfigs
      .filter(
        ({ presentationCategory }) =>
          presentationCategory === "reasoning" ||
          presentationCategory === "service_tier",
      )
      .sort((left, right) =>
        left.presentationCategory === right.presentationCategory
          ? 0
          : left.presentationCategory === "reasoning"
            ? -1
            : 1,
      )
      .map(({ option, options, presentationCategory }) => ({
        kind: presentationCategory as "reasoning" | "service_tier",
        optionId: option.id,
        label:
          presentationCategory === "reasoning" ? "Reasoning" : "Service Tier",
        value: option.value,
        options:
          presentationCategory === "service_tier"
            ? normalizeServiceTierOptions(options, option.description)
            : options,
        defaultValues:
          presentationCategory === "service_tier"
            ? defaultServiceTierValues(options)
            : [],
      }));

    return sections;
  }, [visibleConfigs]);
  const traitDropdown = useMemo(() => {
    const reasoningSection = traitSections.find(
      (section) => section.kind === "reasoning",
    );
    const serviceTierSection = traitSections.find(
      (section) => section.kind === "service_tier",
    );
    const primarySection =
      reasoningSection ?? serviceTierSection ?? traitSections[0];
    if (!primarySection) {
      return null;
    }

    const selected = primarySection.options.find(
      (option) => option.value === primarySection.value,
    );
    return {
      // Reasoning remains the trigger's primary value. Service tier is exposed
      // in the same menu and only changes the trigger icon when Fast is active.
      label: reasoningSection
        ? serviceTierSection
          ? "Reasoning and Service Tier"
          : "Reasoning"
        : "Service Tier",
      value: primarySection.value,
      displayValue:
        selected?.label ??
        (primarySection.value.trim()
          ? formatFallbackLabel(primarySection.value)
          : "Traits"),
      fastModeEnabled: Boolean(
        serviceTierSection && isFastServiceTierValue(serviceTierSection.value),
      ),
      options: traitSections.flatMap((section) =>
        section.options.map((option) => ({
          ...option,
          configOptionId: section.optionId,
          groupLabel: section.label,
          isDefault: section.defaultValues.includes(option.value),
          selected: option.value === section.value,
        })),
      ),
    };
  }, [traitSections]);
  const visibleExtraConfigs = useMemo(
    () =>
      visibleConfigs
        .filter(({ presentationCategory }) => presentationCategory === "other")
        .map(({ option, options }) => ({
          option,
          label: option.label,
          options,
        })),
    [visibleConfigs],
  );
  const compactOptions = useMemo<DropdownOption[]>(() => {
    const options: DropdownOption[] = traitDropdown
      ? [...traitDropdown.options]
      : [];

    for (const { option, label, options: configOptions } of visibleExtraConfigs) {
      options.push(
        ...configOptions.map((configOption) => ({
          ...configOption,
          configOptionId: option.id,
          groupLabel: label,
          selected: configOption.value === option.value,
        })),
      );
    }

    options.push(
      ...modes.map((mode) => ({
        value: mode.id,
        label: formatFallbackLabel(mode.name),
        description: mode.description,
        disabled: mode.disabled,
        configOptionId: COMPOSER_MODE_OPTION_ID,
        groupLabel: "Access",
        selected: mode.id === modeId,
      })),
    );

    return options;
  }, [modeId, modes, traitDropdown, visibleExtraConfigs]);
  const showProviderPicker =
    providers.length > 0 && Boolean(runtimeId && onProviderModelChange);
  const showLegacyModelPicker =
    providers.length === 0 && lockedModelOptions.length > 0;
  const hasControlBeforeExtras = showProviderPicker || showLegacyModelPicker;

  return (
    <div className="nw-agent-controls flex min-w-0 w-full flex-wrap items-center gap-1">
      {showProviderPicker && runtimeId && onProviderModelChange ? (
        <AIProviderModelPicker
          disabled={disabled}
          conversationStarted={conversationStarted}
          runtimeId={runtimeId}
          modelId={selectedModelId}
          providers={providerPickerOptions}
          onChange={onProviderModelChange}
          onProviderActivate={onProviderActivate}
        />
      ) : null}
      {showLegacyModelPicker ? (
        <DropdownField
          disabled={disabled}
          label="Model"
          value={selectedModelId}
          searchable={shouldUseSearchableModelMenu(runtimeId)}
          searchPlaceholder="Search models..."
          emptySearchMessage="No models match that search."
          options={lockedModelOptions}
          onChange={(value) =>
            modelConfig
              ? onConfigOptionChange(modelConfig.id, value)
              : onModelChange(value)
          }
        />
      ) : null}
      <div className="nw-agent-controls-expanded-only contents">
        {traitDropdown ? (
          <>
          {hasControlBeforeExtras ? <ControlSeparator /> : null}
          <DropdownField
            disabled={disabled}
            displayValue={traitDropdown.displayValue}
            label={traitDropdown.label}
            leadingIcon={
              traitDropdown.fastModeEnabled ? <FastModeIcon /> : undefined
            }
            menuMinWidth={168}
            options={traitDropdown.options}
            value={traitDropdown.value}
            onOptionChange={(value, option) => {
              if (option.configOptionId) {
                onConfigOptionChange(option.configOptionId, value);
              }
            }}
          />
          </>
        ) : null}
        {visibleExtraConfigs.map(({ option, label, options }, index) => (
        <div className="contents" key={option.id}>
          {hasControlBeforeExtras || traitSections.length > 0 || index > 0 ? (
            <ControlSeparator />
          ) : null}
          <DropdownField
            disabled={disabled}
            label={label}
            value={option.value}
            options={options}
            onChange={(value) => onConfigOptionChange(option.id, value)}
          />
        </div>
        ))}
        {modes.length > 0 ? (
          <>
          {hasControlBeforeExtras ||
          traitSections.length > 0 ||
          visibleExtraConfigs.length > 0 ? (
            <ControlSeparator />
          ) : null}
          <DropdownField
            disabled={disabled}
            label="Approval Preset"
            leadingIcon={
              <PermissionModeIcon
                fullAccess={modeId === CODEX_FULL_ACCESS_MODE_ID}
              />
            }
            value={modeId}
            options={modes.map((mode) => ({
              value: mode.id,
              label: formatFallbackLabel(mode.name),
              description: mode.description,
              disabled: mode.disabled,
            }))}
            onChange={onModeChange}
          />
          </>
        ) : null}
      </div>
      {compactOptions.length > 0 ? (
        <div className="nw-agent-controls-compact items-center">
          {hasControlBeforeExtras ? <ControlSeparator /> : null}
          <DropdownField
            compact
            disabled={disabled}
            label="Composer options"
            compactLabel={
              traitDropdown?.fastModeEnabled ? "Fast" : undefined
            }
            leadingIcon={
              traitDropdown?.fastModeEnabled ? <FastModeIcon /> : undefined
            }
            menuMinWidth={220}
            options={compactOptions}
            trailingIcon={<ComposerOptionsIcon />}
            value=""
            onOptionChange={(value, option) => {
              if (option.configOptionId === COMPOSER_MODE_OPTION_ID) {
                onModeChange(value);
                return;
              }
              if (option.configOptionId) {
                onConfigOptionChange(option.configOptionId, value);
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
