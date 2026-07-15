import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { listen } from "@neverwrite/runtime";
import { getCurrentWebviewWindow } from "@neverwrite/runtime";
import { openPath, openUrl, revealItemInDir } from "@neverwrite/runtime";
import {
    EDITOR_FONT_FAMILY_OPTIONS,
    PDF_DEFAULT_ZOOM_STEPS,
    useSettingsStore,
    type EditorFontFamily,
    type SpellcheckLanguage,
    type SpellcheckSecondaryLanguage,
} from "../../app/store/settingsStore";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { useThemeStore } from "../../app/store/themeStore";
import { themes, type ThemeName } from "../../app/themes/index";
import {
    clearRecentVaults,
    useVaultStore,
    getRecentVaults,
    removeVaultFromList,
    type RecentVault,
} from "../../app/store/vaultStore";
import { useChatStore } from "../ai/store/chatStore";
import type { AIStorageScope } from "../ai/store/chatStore";
import type { ActivityDisplayMode } from "../ai/activityDisplayMode";
import { useSpellcheckStore } from "../spellcheck/store";
import { getShortcutSettingsEntries } from "../../app/shortcuts/registry";
import {
    formatPrimaryShortcut,
    formatShortcutAction,
} from "../../app/shortcuts/format";
import {
    buildSpellcheckLanguageDescription,
    buildSpellcheckLanguageSelectOptions,
    buildSpellcheckSecondaryLanguageDescription,
    buildSpellcheckSecondaryLanguageSelectOptions,
    buildSpellcheckLanguagesSummary,
} from "../spellcheck/language";
import { WindowChrome } from "../../components/layout/WindowChrome";
import { SETTINGS_OPEN_SECTION_EVENT } from "../../app/detachedWindows";
import { getDesktopPlatform } from "../../app/utils/platform";
import { readSearchParam } from "../../app/utils/safeBrowser";
import { subscribeSafeStorage } from "../../app/utils/safeStorage";
import { checkClaudeCodeInstalled } from "../terminal/claudeCodeTerminal";
import { APP_BRAND_NAME } from "../../app/utils/branding";
import {
    APP_ZOOM_STEP,
    MAX_APP_ZOOM,
    MIN_APP_ZOOM,
    readAppZoom,
    subscribeAppZoom,
    writeAppZoom,
} from "../../app/utils/appZoom";
import { MarkdownContent } from "../ai/components/MarkdownContent";
import { getChatPillMetrics } from "../ai/components/chatPillMetrics";
import { SCREENSHOT_RETENTION_OPTIONS } from "../ai/screenshotRetention";
import { PROVIDER_CATALOG } from "../ai/utils/runtimeMetadata";
import { aiLoadSessionHistories } from "../ai/api";
import type { PersistedSessionHistory } from "../ai/types";
import { AIProvidersSettings } from "./AIProvidersSettings";
import { ExtensionFilterInput } from "./ExtensionFilterInput";
import { useAppUpdateStore } from "../updates/store";
import {
    isWindowOperationalStateStorageKey,
    readSensitiveUpdateState,
    readSettledSensitiveUpdateState,
    type SensitiveUpdateState,
} from "../updates/sensitiveState";
import {
    EMPTY_SEARCH_QUERY,
    createSettingsSearchQuery,
    matchesSettingsSearch,
    sectionHasSettingsSearchMatches,
    type SearchValue,
    type SettingsSearchQuery,
} from "./settingsSearch";

// --- Primitives ---

function hasMigratableHistoryContent(history: PersistedSessionHistory) {
    return (
        (history.message_count ?? history.messages.length) > 0 ||
        history.parent_session_id != null ||
        history.closed_at != null ||
        Boolean(history.custom_title?.trim())
    );
}

function Toggle({
    value,
    onChange,
    disabled,
}: {
    value: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <button
            role="switch"
            aria-checked={value}
            disabled={disabled}
            onClick={() => !disabled && onChange(!value)}
            className="nw-settings-toggle"
            style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                border: "none",
                cursor: disabled ? "not-allowed" : "pointer",
                backgroundColor: value ? "var(--accent)" : "var(--bg-tertiary)",
                position: "relative",
                flexShrink: 0,
                opacity: disabled ? 0.4 : 1,
            }}
        >
            <span
                style={{
                    position: "absolute",
                    top: 2,
                    left: value ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    backgroundColor: "#fff",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                    transition: "left 150ms",
                }}
            />
        </button>
    );
}

function SegmentedControl<T extends string | number>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div
            style={{
                display: "inline-flex",
                backgroundColor: "var(--bg-tertiary)",
                borderRadius: 7,
                padding: 2,
                gap: 1,
            }}
        >
            {options.map((opt) => {
                const active = opt.value === value;
                return (
                    <button
                        key={String(opt.value)}
                        onClick={() => onChange(opt.value)}
                        data-active={active || undefined}
                        className="nw-settings-segment"
                        style={{
                            padding: "3px 10px",
                            borderRadius: 5,
                            border: "none",
                            cursor: "pointer",
                            fontSize: 12,
                            fontFamily: "inherit",
                            backgroundColor: active
                                ? "var(--bg-secondary)"
                                : "transparent",
                            color: active
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            boxShadow: active
                                ? "0 1px 3px rgba(0,0,0,0.1)"
                                : "none",
                            fontWeight: active ? 500 : 400,
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

type SelectFieldOption<T extends string | number | null> = {
    value: T;
    label: string;
    group?: string;
};

const SCREENSHOT_RETENTION_KEYWORDS = SCREENSHOT_RETENTION_OPTIONS.map(
    (option) => option.label,
);

function SelectField<T extends string | number | null>({
    value,
    options,
    onChange,
    disabled,
}: {
    value: T;
    options: SelectFieldOption<T>[];
    onChange: (v: T) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuPosition, setMenuPosition] = useState<{
        x: number;
        y: number;
        minWidth: number;
    } | null>(null);
    const currentLabel =
        options.find((o) => o.value === value)?.label ?? String(value);

    useLayoutEffect(() => {
        if (!open) return;
        const anchor = ref.current;
        const menu = menuRef.current;
        if (!anchor || !menu) return;

        const gap = 4;
        const anchorRect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const shouldOpenAbove =
            anchorRect.bottom + gap + menuRect.height >
                window.innerHeight - 8 &&
            anchorRect.top - gap - menuRect.height >= 8;
        const rawY = shouldOpenAbove
            ? anchorRect.top - gap - menuRect.height
            : anchorRect.bottom + gap;
        const safe = getViewportSafeMenuPosition(
            anchorRect.right - menuRect.width,
            rawY,
            menuRect.width,
            menuRect.height,
        );

        setMenuPosition({
            x: safe.x,
            y: safe.y,
            minWidth: anchorRect.width,
        });
    }, [open, options.length]);

    useEffect(() => {
        if (!open) return;
        const handleDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (ref.current?.contains(target)) return;
            if (menuRef.current?.contains(target)) return;
            setOpen(false);
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
            }
        };
        const handleResize = () => setOpen(false);
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("resize", handleResize);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("resize", handleResize);
        };
    }, [open]);

    return (
        <div
            ref={ref}
            style={{ position: "relative", display: "inline-block" }}
        >
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen((v) => !v)}
                data-open={open ? "true" : undefined}
                className="nw-settings-select"
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "3px 8px",
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: disabled ? "not-allowed" : "pointer",
                    outline: "none",
                    opacity: disabled ? 0.4 : 1,
                    whiteSpace: "nowrap",
                }}
            >
                {currentLabel}
                <svg
                    width="9"
                    height="9"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                        color: "var(--text-secondary)",
                        opacity: 0.7,
                        transform: open ? "rotate(180deg)" : "none",
                        transition: "transform 0.12s ease",
                        flexShrink: 0,
                    }}
                >
                    <path d="M2.5 4L5 6.5L7.5 4" />
                </svg>
            </button>

            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        style={{
                            position: "fixed",
                            left: menuPosition?.x ?? 8,
                            top: menuPosition?.y ?? 8,
                            zIndex: 10010,
                            minWidth: menuPosition?.minWidth ?? 0,
                            padding: 4,
                            borderRadius: 8,
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                            maxHeight: 280,
                            overflowY: "auto",
                        }}
                    >
                        {options.map((opt, index) => {
                            const previousGroup = options[index - 1]?.group;
                            const showGroupLabel =
                                opt.group != null &&
                                opt.group !== previousGroup;

                            return (
                                <div key={String(opt.value)}>
                                    {showGroupLabel ? (
                                        <div
                                            style={{
                                                padding:
                                                    index === 0
                                                        ? "3px 10px 4px"
                                                        : "9px 10px 4px",
                                                fontSize: 10,
                                                fontWeight: 700,
                                                letterSpacing: "0.08em",
                                                textTransform: "uppercase",
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            {opt.group}
                                        </div>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onChange(opt.value);
                                            setOpen(false);
                                        }}
                                        className="nw-settings-select-item"
                                        style={{
                                            display: "block",
                                            width: "100%",
                                            textAlign: "left",
                                            padding: "5px 10px",
                                            fontSize: 12,
                                            fontFamily: "inherit",
                                            borderRadius: 4,
                                            border: "none",
                                            color:
                                                opt.value === value
                                                    ? "var(--accent)"
                                                    : "var(--text-primary)",
                                            backgroundColor: "transparent",
                                            cursor: "pointer",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {opt.label}
                                    </button>
                                </div>
                            );
                        })}
                    </div>,
                    document.body,
                )}
        </div>
    );
}

function NumberStepper({
    value,
    min,
    max,
    step = 1,
    onChange,
}: {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [local, setLocal] = useState(String(value));
    const [isEditing, setIsEditing] = useState(false);

    const commit = (raw: string) => {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        setLocal(String(!isNaN(n) ? Math.max(min, Math.min(max, n)) : value));
    };

    return (
        <div
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                overflow: "hidden",
            }}
        >
            <button
                type="button"
                aria-label="Decrement"
                disabled={value <= min}
                onClick={() => onChange(Math.max(min, value - step))}
                className="nw-settings-stepper-btn"
                style={{
                    width: 24,
                    height: 26,
                    border: "none",
                    background: "transparent",
                    cursor: value <= min ? "not-allowed" : "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: value <= min ? 0.45 : 1,
                }}
            >
                −
            </button>
            <input
                ref={inputRef}
                value={isEditing ? local : String(value)}
                onFocus={() => {
                    setLocal(String(value));
                    setIsEditing(true);
                }}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={() => {
                    commit(local);
                    setIsEditing(false);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commit(local);
                        setIsEditing(false);
                        inputRef.current?.blur();
                    }
                    if (e.key === "Escape") {
                        e.preventDefault();
                        setLocal(String(value));
                        setIsEditing(false);
                        inputRef.current?.blur();
                    }
                }}
                className="nw-settings-stepper-input"
                style={{
                    width: 34,
                    textAlign: "center",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    fontFamily: "inherit",
                    outline: "none",
                }}
            />
            <button
                type="button"
                aria-label="Increment"
                disabled={value >= max}
                onClick={() => onChange(Math.min(max, value + step))}
                className="nw-settings-stepper-btn"
                style={{
                    width: 24,
                    height: 26,
                    border: "none",
                    background: "transparent",
                    cursor: value >= max ? "not-allowed" : "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: value >= max ? 0.45 : 1,
                }}
            >
                +
            </button>
        </div>
    );
}

function SliderField({
    value,
    min,
    max,
    step = 1,
    onChange,
    formatValue,
}: {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    formatValue?: (value: number) => string;
}) {
    const progress = ((value - min) / (max - min)) * 100;

    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minWidth: 220,
            }}
        >
            <input
                className="settings-range-slider"
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                style={{
                    width: 160,
                    cursor: "pointer",
                    ["--slider-progress" as string]: `${progress}%`,
                }}
            />
            <span
                style={{
                    minWidth: 42,
                    textAlign: "right",
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--text-secondary)",
                }}
            >
                {formatValue ? formatValue(value) : value}
            </span>
        </div>
    );
}

// --- Theme Picker ---

const THEME_ORDER: ThemeName[] = [
    "default",
    "ocean",
    "forest",
    "rose",
    "amber",
    "lavender",
    "nord",
    "sunset",
    "catppuccin",
    "solarized",
    "tokyoNight",
    "gruvbox",
    "ayu",
    "nightOwl",
    "vesper",
    "rosePine",
    "kanagawa",
    "everforest",
    "synthwave84",
    "claude",
    "codex",
];

function ThemePicker({
    value,
    onChange,
}: {
    value: ThemeName;
    onChange: (name: ThemeName) => void;
}) {
    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 10,
                padding: "8px 0",
            }}
        >
            {THEME_ORDER.map((name) => {
                const theme = themes[name];
                const active = name === value;
                return (
                    <button
                        key={name}
                        onClick={() => onChange(name)}
                        data-active={active || undefined}
                        className="nw-settings-theme-tile"
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 6,
                            padding: 8,
                            borderRadius: 8,
                            border: active
                                ? "2px solid var(--accent)"
                                : "2px solid var(--border)",
                            background: "var(--bg-secondary)",
                            cursor: "pointer",
                        }}
                    >
                        {/* Color preview */}
                        <div
                            style={{
                                width: "100%",
                                height: 32,
                                borderRadius: 4,
                                overflow: "hidden",
                                display: "flex",
                            }}
                        >
                            <div
                                style={{
                                    flex: 1,
                                    backgroundColor: theme.light.bgPrimary,
                                }}
                            />
                            <div
                                style={{
                                    flex: 1,
                                    backgroundColor: theme.dark.bgPrimary,
                                }}
                            />
                            <div
                                style={{
                                    width: 8,
                                    backgroundColor: theme.light.accent,
                                }}
                            />
                        </div>
                        <span
                            style={{
                                fontSize: 11,
                                fontWeight: active ? 600 : 400,
                                color: active
                                    ? "var(--accent)"
                                    : "var(--text-secondary)",
                            }}
                        >
                            {theme.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

// --- Row ---

function Row({
    label,
    description,
    control,
    disabled,
}: {
    label: string;
    description?: string;
    control: React.ReactNode;
    disabled?: boolean;
}) {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "11px 0",
                borderBottom: "1px solid var(--border)",
                opacity: disabled ? 0.45 : 1,
                gap: 24,
            }}
        >
            <div style={{ minWidth: 0 }}>
                <div
                    style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        lineHeight: 1.3,
                    }}
                >
                    {label}
                </div>
                {description && (
                    <div
                        style={{
                            fontSize: 11,
                            color: "var(--text-secondary)",
                            marginTop: 2,
                            lineHeight: 1.4,
                        }}
                    >
                        {description}
                    </div>
                )}
            </div>
            <div style={{ flexShrink: 0 }}>{control}</div>
        </div>
    );
}

function SectionLabel({ children }: { children: string }) {
    return (
        <div
            style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-secondary)",
                paddingTop: 20,
                paddingBottom: 4,
            }}
        >
            {children}
        </div>
    );
}

function EmptySettingsSearch({ search }: { search: string }) {
    return (
        <div
            style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
                padding: "24px 0",
            }}
        >
            No settings match "{search.trim()}".
        </div>
    );
}

function EmptyPanelSearchResult() {
    return (
        <div
            style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
                padding: "24px 0",
            }}
        >
            No matching settings in this panel.
        </div>
    );
}

function SearchableRow({
    control,
    description,
    disabled,
    keywords = [],
    label,
    searchQuery,
    section,
}: {
    control: React.ReactNode;
    description?: string;
    disabled?: boolean;
    keywords?: readonly SearchValue[];
    label: string;
    searchQuery: SettingsSearchQuery;
    section: string;
}) {
    if (
        !matchesSettingsSearch(searchQuery, section, label, description, ...keywords)
    ) {
        return null;
    }

    return (
        <Row
            control={control}
            description={description}
            disabled={disabled}
            label={label}
        />
    );
}

function formatSpellcheckCatalogSize(sizeBytes: number, sizeKnown: boolean) {
    if (!sizeKnown || sizeBytes <= 0) {
        return "Size unknown";
    }

    if (sizeBytes >= 1024 * 1024) {
        return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${Math.round(sizeBytes / 1024)} KB`;
}

function formatUpdateDate(date: string | undefined) {
    if (!date) {
        return "Unknown";
    }

    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
        return date;
    }

    return parsed.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

// --- Category content ---

function GeneralSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const { openLastVaultOnLaunch, tabOpenBehavior, setSetting } =
        useSettingsStore();
    const showStartup = sectionHasSettingsSearchMatches(searchQuery, "Startup", [
        [
            "Open last vault on launch",
            `Automatically reopen the last vault when ${APP_BRAND_NAME} starts.`,
        ],
    ]);
    const showTabs = sectionHasSettingsSearchMatches(searchQuery, "Tabs", [
        [
            "Open behavior",
            "Choose whether opening notes, files, and AI chats reuses the current tab history or creates a new tab.",
            "History",
            "New tab",
        ],
    ]);

    if (!showStartup && !showTabs) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showStartup ? <SectionLabel>Startup</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Startup"
                label="Open last vault on launch"
                description={`Automatically reopen the last vault when ${APP_BRAND_NAME} starts.`}
                control={
                    <Toggle
                        value={openLastVaultOnLaunch}
                        onChange={(v) => setSetting("openLastVaultOnLaunch", v)}
                    />
                }
            />

            {showTabs ? <SectionLabel>Tabs</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Tabs"
                label="Open behavior"
                description="Choose whether opening notes, files, and AI chats reuses the current tab history or creates a new tab."
                keywords={["History", "New tab"]}
                control={
                    <SegmentedControl
                        value={tabOpenBehavior}
                        options={[
                            { value: "history", label: "History" },
                            { value: "new_tab", label: "New tab" },
                        ]}
                        onChange={(value) =>
                            setSetting("tabOpenBehavior", value)
                        }
                    />
                }
            />
        </div>
    );
}

const APP_ZOOM_PERCENT_MIN = Math.round(MIN_APP_ZOOM * 100);
const APP_ZOOM_PERCENT_MAX = Math.round(MAX_APP_ZOOM * 100);
const APP_ZOOM_PERCENT_STEP = Math.round(APP_ZOOM_STEP * 100);

function appZoomToPercent(zoom: number) {
    return Math.round(zoom * 100);
}

function useAppZoomPercent() {
    const [appZoomPercent, setAppZoomPercent] = useState(() =>
        appZoomToPercent(readAppZoom()),
    );

    useEffect(() => {
        return subscribeAppZoom((nextZoom) => {
            setAppZoomPercent(appZoomToPercent(nextZoom));
        });
    }, []);

    const writeAppZoomPercent = (nextPercent: number) => {
        const nextZoom = writeAppZoom(nextPercent / 100);
        setAppZoomPercent(appZoomToPercent(nextZoom));
    };

    return [appZoomPercent, writeAppZoomPercent] as const;
}

function AppearanceSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const { mode, setMode, themeName, setThemeName } = useThemeStore();
    const {
        fileTreeScale,
        agentsSidebarScale,
        fileTreeStickyFolders,
        setSetting,
    } = useSettingsStore();
    const [appZoomPercent, setAppZoomPercent] = useAppZoomPercent();
    const platform = getDesktopPlatform();
    const appZoomShortcut = [
        formatShortcutAction("zoom_in", platform),
        formatShortcutAction("zoom_out", platform),
        formatShortcutAction("reset_zoom", platform),
    ].join(" / ");
    const showMode = sectionHasSettingsSearchMatches(searchQuery, "Mode", [
        [
            "System theme",
            `Choose how ${APP_BRAND_NAME} looks. 'System' follows your OS preference.`,
            "System",
            "Light",
            "Dark",
        ],
    ]);
    const showTheme = matchesSettingsSearch(
        searchQuery,
        "Theme",
        "Themes",
        "Visual preferences",
        ...THEME_ORDER.flatMap((name) => [name, themes[name].label]),
    );
    const showNavigation = sectionHasSettingsSearchMatches(
        searchQuery,
        "Navigation",
        [
            [
                "File tree size",
                "Scale text and rows in the file tree, in percent.",
            ],
            [
                "Agents size",
                "Scale text and rows in the Agents sidebar, in percent.",
            ],
            [
                "Sticky folders",
                "Keep parent folders pinned at the top while scrolling the file tree.",
            ],
        ],
    );
    const showZoom = sectionHasSettingsSearchMatches(searchQuery, "Zoom", [
        [
            "App zoom",
            `Scale the entire app UI, in percent. Use ${appZoomShortcut} from the keyboard or the View menu. Editor, chat, and composer font sizes stay independent.`,
            appZoomShortcut,
        ],
    ]);

    if (!showMode && !showTheme && !showNavigation && !showZoom) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showMode ? <SectionLabel>Mode</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Mode"
                label="System theme"
                description={`Choose how ${APP_BRAND_NAME} looks. 'System' follows your OS preference.`}
                keywords={["System", "Light", "Dark"]}
                control={
                    <SegmentedControl
                        value={mode}
                        options={[
                            { value: "system", label: "System" },
                            { value: "light", label: "Light" },
                            { value: "dark", label: "Dark" },
                        ]}
                        onChange={setMode}
                    />
                }
            />

            {showTheme ? (
                <>
                    <SectionLabel>Theme</SectionLabel>
                    <ThemePicker value={themeName} onChange={setThemeName} />
                </>
            ) : null}

            {showNavigation ? <SectionLabel>Navigation</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Navigation"
                label="File tree size"
                description="Scale text and rows in the file tree, in percent."
                control={
                    <NumberStepper
                        value={fileTreeScale}
                        min={90}
                        max={140}
                        onChange={(v) => setSetting("fileTreeScale", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Navigation"
                label="Agents size"
                description="Scale text and rows in the Agents sidebar, in percent."
                control={
                    <NumberStepper
                        value={agentsSidebarScale}
                        min={90}
                        max={140}
                        onChange={(v) => setSetting("agentsSidebarScale", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Navigation"
                label="Sticky folders"
                description="Keep parent folders pinned at the top while scrolling the file tree."
                control={
                    <Toggle
                        value={fileTreeStickyFolders}
                        onChange={(v) =>
                            setSetting("fileTreeStickyFolders", v)
                        }
                    />
                }
            />

            {showZoom ? <SectionLabel>Zoom</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Zoom"
                label="App zoom"
                description={`Scale the entire app UI, in percent. Use ${appZoomShortcut} from the keyboard or the View menu. Editor, chat, and composer font sizes stay independent.`}
                keywords={[appZoomShortcut]}
                control={
                    <NumberStepper
                        value={appZoomPercent}
                        min={APP_ZOOM_PERCENT_MIN}
                        max={APP_ZOOM_PERCENT_MAX}
                        step={APP_ZOOM_PERCENT_STEP}
                        onChange={setAppZoomPercent}
                    />
                }
            />
        </div>
    );
}

const PDF_DEFAULT_ZOOM_OPTIONS: { value: string; label: string }[] = [
    { value: "fit-width", label: "Fit width" },
    ...PDF_DEFAULT_ZOOM_STEPS.map((zoom) => ({
        value: String(zoom),
        label: `${Math.round(zoom * 100)}%`,
    })),
];

function EditorSettings({ searchQuery }: { searchQuery: SettingsSearchQuery }) {
    const {
        editorFontSize,
        editorFontFamily,
        editorLineHeight,
        editorAutosaveDelayMs,
        editorContentWidth,
        lineWrapping,
        editorActiveLineHighlight,
        justifyText,
        tabSize,
        hoverPreviewEnabled,
        hoverPreviewDelayMs,
        pdfDefaultZoom,
        vimModeEnabled,
        vimRelativeLineNumbers,
        setSetting,
    } = useSettingsStore();
    const showTypography = sectionHasSettingsSearchMatches(
        searchQuery,
        "Typography",
        [
            ["Font size", "Text size in the editor, in pixels."],
            [
                "Font family",
                "Font used in the editor.",
                ...EDITOR_FONT_FAMILY_OPTIONS.flatMap((option) => [
                    option.value,
                    option.label,
                    option.group,
                ]),
            ],
            ["Line spacing", "Line height in the editor. 150 means 1.5x."],
            [
                "Autosave delay",
                "Delay before saving note and text-file edits automatically, in milliseconds.",
            ],
        ],
    );
    const showFormatting = sectionHasSettingsSearchMatches(
        searchQuery,
        "Formatting",
        [
            ["Line wrapping", "Wrap long lines to fit the editor width."],
            [
                "Highlight active line",
                "Highlight the line containing the cursor.",
                "current line",
                "cursor line",
            ],
            [
                "Justify text",
                "Distribute wrapped lines evenly across the editor width.",
            ],
            ["Tab size", "Number of spaces inserted when pressing Tab.", 2, 4],
        ],
    );
    const showPreview = sectionHasSettingsSearchMatches(
        searchQuery,
        "Preview",
        [
            [
                "Note preview on hover",
                "Show a floating preview of the linked note when hovering over a [[wikilink]]. This preference applies to all vaults.",
                "wikilink",
                "popover",
                "tooltip",
            ],
            [
                "Hover delay",
                "Time the pointer must rest on a wikilink before the preview opens, in milliseconds.",
            ],
        ],
    );
    const showVim = sectionHasSettingsSearchMatches(searchQuery, "Vim", [
        [
            "Vim key bindings",
            "Use modal (vim) editing in the note editor.",
            "vim",
        ],
        [
            "Relative line numbers",
            "Show line numbers as distance from the cursor line.",
        ],
    ]);
    const showLayout = sectionHasSettingsSearchMatches(searchQuery, "Layout", [
        ["Text width", "Maximum width of the editor content, in pixels."],
    ]);
    const showPdf = sectionHasSettingsSearchMatches(searchQuery, "PDF", [
        [
            "Default zoom",
            "Zoom level applied when a PDF is opened. Fit width scales the page to the viewport.",
            ...PDF_DEFAULT_ZOOM_OPTIONS.map((option) => option.label),
        ],
    ]);

    if (
        !showTypography &&
        !showFormatting &&
        !showPreview &&
        !showVim &&
        !showLayout &&
        !showPdf
    ) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showTypography ? <SectionLabel>Typography</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Font size"
                description="Text size in the editor, in pixels."
                control={
                    <NumberStepper
                        value={editorFontSize}
                        min={10}
                        max={24}
                        onChange={(v) => setSetting("editorFontSize", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Font family"
                description="Font used in the editor."
                keywords={EDITOR_FONT_FAMILY_OPTIONS.flatMap((option) => [
                    option.value,
                    option.label,
                    option.group,
                ])}
                control={
                    <SelectField
                        value={editorFontFamily}
                        options={EDITOR_FONT_FAMILY_OPTIONS}
                        onChange={(v) =>
                            setSetting(
                                "editorFontFamily",
                                v as EditorFontFamily,
                            )
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Line spacing"
                description="Line height in the editor. 150 means 1.5×."
                control={
                    <SliderField
                        value={editorLineHeight}
                        min={120}
                        max={220}
                        step={5}
                        onChange={(v) => setSetting("editorLineHeight", v)}
                        formatValue={(value) => `${value}%`}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Typography"
                label="Autosave delay"
                description="Delay before saving note and text-file edits automatically, in milliseconds."
                control={
                    <NumberStepper
                        value={editorAutosaveDelayMs}
                        min={50}
                        max={5000}
                        onChange={(v) =>
                            setSetting("editorAutosaveDelayMs", v)
                        }
                    />
                }
            />

            {showFormatting ? <SectionLabel>Formatting</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Formatting"
                label="Line wrapping"
                description="Wrap long lines to fit the editor width."
                control={
                    <Toggle
                        value={lineWrapping}
                        onChange={(v) => setSetting("lineWrapping", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Formatting"
                label="Highlight active line"
                description="Highlight the line containing the cursor."
                keywords={["current line", "cursor line"]}
                control={
                    <Toggle
                        value={editorActiveLineHighlight}
                        onChange={(v) =>
                            setSetting("editorActiveLineHighlight", v)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Formatting"
                label="Justify text"
                description="Distribute wrapped lines evenly across the editor width."
                control={
                    <Toggle
                        value={justifyText}
                        onChange={(v) => setSetting("justifyText", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Formatting"
                label="Tab size"
                description="Number of spaces inserted when pressing Tab."
                keywords={[2, 4]}
                control={
                    <SegmentedControl
                        value={tabSize}
                        options={[
                            { value: 2, label: "2" },
                            { value: 4, label: "4" },
                        ]}
                        onChange={(v) => setSetting("tabSize", v as 2 | 4)}
                    />
                }
            />

            {showPreview ? <SectionLabel>Preview</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Preview"
                label="Note preview on hover"
                description="Show a floating preview of the linked note when hovering over a [[wikilink]]. This preference applies to all vaults."
                keywords={["wikilink", "popover", "tooltip"]}
                control={
                    <Toggle
                        value={hoverPreviewEnabled}
                        onChange={(v) => setSetting("hoverPreviewEnabled", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Preview"
                label="Hover delay"
                description="Time the pointer must rest on a wikilink before the preview opens, in milliseconds."
                control={
                    <SliderField
                        value={hoverPreviewDelayMs}
                        min={100}
                        max={1500}
                        step={50}
                        onChange={(v) =>
                            setSetting("hoverPreviewDelayMs", v)
                        }
                        formatValue={(value) => `${value}ms`}
                    />
                }
            />

            {showVim ? <SectionLabel>Vim</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Vim"
                label="Vim key bindings"
                description="Use modal (vim) editing in the note editor."
                keywords={["vim"]}
                control={
                    <Toggle
                        value={vimModeEnabled}
                        onChange={(v) => setSetting("vimModeEnabled", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Vim"
                label="Relative line numbers"
                description="Show line numbers as distance from the cursor line. Applies in code (non–live-preview) mode."
                control={
                    <Toggle
                        value={vimRelativeLineNumbers}
                        onChange={(v) =>
                            setSetting("vimRelativeLineNumbers", v)
                        }
                    />
                }
            />

            {showLayout ? <SectionLabel>Layout</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Layout"
                label="Text width"
                description="Maximum width of the editor content, in pixels."
                control={
                    <SliderField
                        value={editorContentWidth}
                        min={600}
                        max={1200}
                        step={10}
                        onChange={(v) => setSetting("editorContentWidth", v)}
                        formatValue={(value) => `${value}px`}
                    />
                }
            />

            {showPdf ? <SectionLabel>PDF</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="PDF"
                label="Default zoom"
                description="Zoom level applied when a PDF is opened. Fit width scales the page to the viewport."
                keywords={PDF_DEFAULT_ZOOM_OPTIONS.map((option) => option.label)}
                control={
                    <SelectField
                        value={
                            typeof pdfDefaultZoom === "number"
                                ? String(pdfDefaultZoom)
                                : "fit-width"
                        }
                        options={PDF_DEFAULT_ZOOM_OPTIONS}
                        onChange={(v) =>
                            setSetting(
                                "pdfDefaultZoom",
                                v === "fit-width" ? "fit-width" : Number(v),
                            )
                        }
                    />
                }
            />
        </div>
    );
}

function SpellcheckSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const {
        editorSpellcheck,
        spellcheckPrimaryLanguage,
        spellcheckSecondaryLanguage,
        grammarCheckEnabled,
        grammarCheckServerUrl,
        setSetting,
    } = useSettingsStore();
    const spellcheckLanguages = useSpellcheckStore((s) => s.languages);
    const spellcheckCatalog = useSpellcheckStore((s) => s.catalog);
    const spellcheckRuntimeDirectory = useSpellcheckStore(
        (s) => s.runtimeDirectory,
    );
    const spellcheckLastError = useSpellcheckStore((s) => s.lastError);
    const loadSpellcheckLanguages = useSpellcheckStore((s) => s.loadLanguages);
    const loadSpellcheckCatalog = useSpellcheckStore((s) => s.loadCatalog);
    const loadSpellcheckRuntimeDirectory = useSpellcheckStore(
        (s) => s.loadRuntimeDirectory,
    );
    const installCatalogDictionary = useSpellcheckStore(
        (s) => s.installCatalogDictionary,
    );
    const removeInstalledCatalogDictionary = useSpellcheckStore(
        (s) => s.removeInstalledCatalogDictionary,
    );
    const [catalogSearch, setCatalogSearch] = useState("");
    const [pendingCatalogAction, setPendingCatalogAction] = useState<
        string | null
    >(null);
    const [refreshingCatalog, setRefreshingCatalog] = useState(false);
    const [spellcheckCatalogNotice, setSpellcheckCatalogNotice] = useState<{
        tone: "success" | "error";
        message: string;
    } | null>(null);

    useEffect(() => {
        void loadSpellcheckLanguages().catch(() => {});
        void loadSpellcheckCatalog().catch(() => {});
        void loadSpellcheckRuntimeDirectory().catch(() => {});
    }, [
        loadSpellcheckCatalog,
        loadSpellcheckLanguages,
        loadSpellcheckRuntimeDirectory,
    ]);

    const spellcheckPrimaryLanguageOptions =
        buildSpellcheckLanguageSelectOptions(
            spellcheckPrimaryLanguage,
            spellcheckLanguages,
        );
    const spellcheckPrimaryLanguageDescription =
        buildSpellcheckLanguageDescription(
            spellcheckPrimaryLanguage,
            spellcheckLanguages,
            spellcheckRuntimeDirectory,
        );
    const spellcheckSecondaryLanguageOptions =
        buildSpellcheckSecondaryLanguageSelectOptions(
            spellcheckPrimaryLanguage,
            spellcheckSecondaryLanguage,
            spellcheckLanguages,
        );
    const spellcheckSecondaryLanguageDescription =
        buildSpellcheckSecondaryLanguageDescription(
            spellcheckSecondaryLanguage,
            spellcheckLanguages,
            spellcheckRuntimeDirectory,
        );
    const spellcheckLanguagesSummary =
        buildSpellcheckLanguagesSummary(spellcheckLanguages);
    const downloadableCatalogEntries = spellcheckCatalog.filter(
        (entry) => !entry.bundled,
    );
    const catalogSearchQuery = createSettingsSearchQuery(catalogSearch);
    const filteredCatalogEntries = downloadableCatalogEntries.filter((entry) => {
        const values = [
            "Dictionary Catalog",
            "Search languages",
            entry.id,
            entry.label,
            entry.source,
            entry.version,
            entry.installed_version,
            entry.license,
            entry.update_available ? "Update available" : undefined,
            entry.installed ? "Installed" : undefined,
        ];

        return (
            matchesSettingsSearch(catalogSearchQuery, ...values) &&
            matchesSettingsSearch(searchQuery, ...values)
        );
    });
    const spellcheckPacksDirectory = spellcheckRuntimeDirectory
        ? `${spellcheckRuntimeDirectory}/packs`
        : null;
    const showLanguages = sectionHasSettingsSearchMatches(
        searchQuery,
        "Languages",
        [
            [
                "Spellcheck",
                "Use the app spellcheck engine in Markdown notes and note titles.",
            ],
            [
                "Primary language",
                spellcheckPrimaryLanguageDescription,
                spellcheckPrimaryLanguage,
                ...spellcheckPrimaryLanguageOptions.flatMap((option) => [
                    option.value,
                    option.label,
                ]),
            ],
            [
                "Secondary language",
                spellcheckSecondaryLanguageDescription,
                spellcheckSecondaryLanguage,
                ...spellcheckSecondaryLanguageOptions.flatMap((option) => [
                    option.value,
                    option.label,
                ]),
            ],
        ],
    );
    const showGrammar = sectionHasSettingsSearchMatches(
        searchQuery,
        "Grammar Check",
        [
            [
                "Grammar check",
                "Check grammar and style using LanguageTool. Uses the spellcheck primary language.",
                "LanguageTool",
            ],
            [
                "Server URL",
                "Leave empty to use the public LanguageTool API. For privacy, run a local server (e.g. localhost:8081).",
                grammarCheckServerUrl,
                "languagetool.org",
                "local server",
            ],
        ],
    );
    const showDictionaries = sectionHasSettingsSearchMatches(
        searchQuery,
        "Dictionaries",
        [
            [
                "Spellcheck dictionaries",
                "Bundled dictionaries are ready immediately. Downloadable Hunspell packs live in the app spellcheck folder and can be managed even while spellcheck is off.",
                spellcheckLanguagesSummary,
                spellcheckRuntimeDirectory,
                spellcheckPacksDirectory,
                spellcheckLastError,
                spellcheckCatalogNotice?.message,
                "Open Folder",
                "Reload",
                "Hunspell",
            ],
        ],
    );
    const showCatalog =
        downloadableCatalogEntries.length > 0 &&
        (matchesSettingsSearch(
            searchQuery,
            "Dictionary Catalog",
            "Search languages",
            "Download",
            "Update",
            "Remove",
            "Reinstall",
            "Checksum",
            "License",
        ) ||
            filteredCatalogEntries.length > 0);

    if (!showLanguages && !showGrammar && !showDictionaries && !showCatalog) {
        return <EmptyPanelSearchResult />;
    }

    const showSpellcheckNotice = (
        tone: "success" | "error",
        message: string,
    ) => {
        setSpellcheckCatalogNotice({ tone, message });
    };

    const clearSpellcheckNotice = () => {
        setSpellcheckCatalogNotice(null);
    };

    const handleOpenSpellcheckFolder = async () => {
        if (!spellcheckPacksDirectory) {
            showSpellcheckNotice(
                "error",
                "Spellcheck packs folder is not available yet.",
            );
            return;
        }

        clearSpellcheckNotice();

        try {
            await revealItemInDir(spellcheckPacksDirectory);
            showSpellcheckNotice("success", "Spellcheck folder opened.");
        } catch (error) {
            try {
                await openPath(spellcheckPacksDirectory);
                showSpellcheckNotice("success", "Spellcheck folder opened.");
            } catch (fallbackError) {
                const message =
                    fallbackError instanceof Error
                        ? fallbackError.message
                        : error instanceof Error
                          ? error.message
                          : "Could not open the spellcheck folder.";
                showSpellcheckNotice("error", message);
            }
        }
    };

    const handleReloadSpellcheckCatalog = async () => {
        setRefreshingCatalog(true);
        clearSpellcheckNotice();

        try {
            await Promise.all([
                loadSpellcheckLanguages(),
                loadSpellcheckCatalog(),
                loadSpellcheckRuntimeDirectory(),
            ]);
            showSpellcheckNotice(
                "success",
                "Spellcheck dictionaries refreshed.",
            );
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Could not refresh spellcheck dictionaries.";
            showSpellcheckNotice("error", message);
        } finally {
            setRefreshingCatalog(false);
        }
    };

    return (
        <div>
            {showLanguages ? (
                <>
                    <SectionLabel>Languages</SectionLabel>
                    <p
                        style={{
                            fontSize: 11,
                            color: "var(--text-secondary)",
                            margin: "0 0 6px 0",
                            fontStyle: "italic",
                        }}
                    >
                        These settings apply to the current vault only.
                    </p>
                </>
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Languages"
                label="Spellcheck"
                description="Use the app spellcheck engine in Markdown notes and note titles."
                control={
                    <Toggle
                        value={editorSpellcheck}
                        onChange={(v) => setSetting("editorSpellcheck", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Languages"
                label="Primary language"
                description={spellcheckPrimaryLanguageDescription}
                disabled={!editorSpellcheck}
                keywords={[
                    spellcheckPrimaryLanguage,
                    ...spellcheckPrimaryLanguageOptions.flatMap((option) => [
                        option.value,
                        option.label,
                    ]),
                ]}
                control={
                    <SelectField
                        value={spellcheckPrimaryLanguage}
                        disabled={!editorSpellcheck}
                        options={spellcheckPrimaryLanguageOptions}
                        onChange={(value) =>
                            setSetting(
                                "spellcheckPrimaryLanguage",
                                value as SpellcheckLanguage,
                            )
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Languages"
                label="Secondary language"
                description={spellcheckSecondaryLanguageDescription}
                disabled={!editorSpellcheck}
                keywords={[
                    spellcheckSecondaryLanguage,
                    ...spellcheckSecondaryLanguageOptions.flatMap((option) => [
                        option.value,
                        option.label,
                    ]),
                ]}
                control={
                    <SelectField
                        value={spellcheckSecondaryLanguage}
                        disabled={!editorSpellcheck}
                        options={spellcheckSecondaryLanguageOptions}
                        onChange={(value) =>
                            setSetting(
                                "spellcheckSecondaryLanguage",
                                (value as SpellcheckSecondaryLanguage) ?? null,
                            )
                        }
                    />
                }
            />
            {showGrammar ? <SectionLabel>Grammar Check</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Grammar Check"
                label="Grammar check"
                description="Check grammar and style using LanguageTool. Uses the spellcheck primary language."
                keywords={["LanguageTool"]}
                control={
                    <Toggle
                        value={grammarCheckEnabled}
                        onChange={(v) => setSetting("grammarCheckEnabled", v)}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Grammar Check"
                label="Server URL"
                description="Leave empty to use the public LanguageTool API. For privacy, run a local server (e.g. localhost:8081)."
                disabled={!grammarCheckEnabled}
                keywords={[
                    grammarCheckServerUrl,
                    "languagetool.org",
                    "local server",
                ]}
                control={
                    <input
                        type="text"
                        placeholder="https://api.languagetool.org"
                        value={grammarCheckServerUrl}
                        disabled={!grammarCheckEnabled}
                        onChange={(e) =>
                            setSetting("grammarCheckServerUrl", e.target.value)
                        }
                        style={{
                            width: 200,
                            padding: "6px 8px",
                            fontSize: 12,
                            fontFamily: "inherit",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            backgroundColor: grammarCheckEnabled
                                ? "var(--bg-tertiary)"
                                : "var(--bg-secondary)",
                            color: grammarCheckEnabled
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            outline: "none",
                            boxSizing: "border-box",
                            opacity: grammarCheckEnabled ? 1 : 0.5,
                        }}
                    />
                }
            />
            {showGrammar && grammarCheckEnabled && !grammarCheckServerUrl && (
                <p
                    style={{
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        margin: "4px 0 8px 0",
                        lineHeight: 1.5,
                        fontStyle: "italic",
                    }}
                >
                    The public API sends text to languagetool.org for
                    processing. For sensitive content, consider a{" "}
                    <a
                        href="https://dev.languagetool.org/http-server"
                        target="_blank"
                        rel="noreferrer"
                        style={{
                            color: "var(--accent)",
                            textDecoration: "underline",
                        }}
                    >
                        local server
                    </a>
                    .
                </p>
            )}
            {showDictionaries ? <SectionLabel>Dictionaries</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Dictionaries"
                label="Spellcheck dictionaries"
                description="Bundled dictionaries are ready immediately. Downloadable Hunspell packs live in the app spellcheck folder and can be managed even while spellcheck is off."
                keywords={[
                    spellcheckLanguagesSummary,
                    spellcheckRuntimeDirectory,
                    spellcheckPacksDirectory,
                    spellcheckLastError,
                    spellcheckCatalogNotice?.message,
                    "Open Folder",
                    "Reload",
                    "Hunspell",
                ]}
                control={
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-end",
                            gap: 2,
                            maxWidth: 260,
                            textAlign: "right",
                        }}
                    >
                        <span
                            style={{
                                fontSize: 12,
                                color: "var(--text-primary)",
                            }}
                        >
                            {spellcheckLanguagesSummary}
                        </span>
                        {spellcheckRuntimeDirectory && (
                            <span
                                style={{
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                    lineHeight: 1.4,
                                }}
                            >
                                {spellcheckPacksDirectory}
                            </span>
                        )}
                        <div
                            style={{
                                display: "flex",
                                gap: 8,
                                marginTop: 6,
                            }}
                        >
                            {spellcheckPacksDirectory && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        void handleOpenSpellcheckFolder();
                                    }}
                                    style={{
                                        borderRadius: 6,
                                        border: "1px solid var(--border)",
                                        backgroundColor: "var(--bg-tertiary)",
                                        color: "var(--text-primary)",
                                        padding: "6px 10px",
                                        fontSize: 12,
                                        fontFamily: "inherit",
                                        cursor: "pointer",
                                    }}
                                >
                                    Open Folder
                                </button>
                            )}
                            <button
                                type="button"
                                disabled={refreshingCatalog}
                                onClick={() => {
                                    void handleReloadSpellcheckCatalog();
                                }}
                                style={{
                                    borderRadius: 6,
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-tertiary)",
                                    color: "var(--text-primary)",
                                    padding: "6px 10px",
                                    fontSize: 12,
                                    fontFamily: "inherit",
                                    cursor: refreshingCatalog
                                        ? "not-allowed"
                                        : "pointer",
                                    opacity: refreshingCatalog ? 0.5 : 1,
                                }}
                            >
                                {refreshingCatalog ? "Refreshing..." : "Reload"}
                            </button>
                        </div>
                    </div>
                }
            />
            {showCatalog && (
                <>
                    <SectionLabel>Dictionary Catalog</SectionLabel>
                    <div style={{ marginBottom: 8 }}>
                        <input
                            type="text"
                            placeholder="Search languages..."
                            value={catalogSearch}
                            onChange={(e) => setCatalogSearch(e.target.value)}
                            style={{
                                width: "100%",
                                padding: "7px 10px",
                                fontSize: 12,
                                fontFamily: "inherit",
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                outline: "none",
                                boxSizing: "border-box",
                            }}
                        />
                    </div>
                    {filteredCatalogEntries.map((entry) => {
                        const pendingInstall =
                            pendingCatalogAction === `${entry.id}:install`;
                        const pendingRemove =
                            pendingCatalogAction === `${entry.id}:remove`;
                        const installLabel = entry.update_available
                            ? "Update"
                            : entry.installed
                              ? "Reinstall"
                              : "Download";
                        const description = [
                            `Version ${entry.version}`,
                            entry.installed_version &&
                            entry.installed_version !== entry.version
                                ? `Installed ${entry.installed_version}`
                                : null,
                            formatSpellcheckCatalogSize(
                                entry.size_bytes,
                                entry.size_known,
                            ),
                            entry.license,
                            !entry.bundled && !entry.integrity_available
                                ? "Checksum unavailable"
                                : null,
                        ]
                            .filter(Boolean)
                            .join(" · ");

                        return (
                            <Row
                                key={entry.id}
                                label={entry.label}
                                description={`${entry.source} · ${description}${
                                    entry.update_available
                                        ? " · Update available"
                                        : ""
                                }`}
                                disabled={pendingInstall || pendingRemove}
                                control={
                                    <div
                                        style={{
                                            display: "flex",
                                            gap: 8,
                                        }}
                                    >
                                        <button
                                            type="button"
                                            disabled={
                                                pendingInstall || pendingRemove
                                            }
                                            onClick={() => {
                                                setPendingCatalogAction(
                                                    `${entry.id}:install`,
                                                );
                                                clearSpellcheckNotice();
                                                void installCatalogDictionary(
                                                    entry.id,
                                                )
                                                    .then(() => {
                                                        showSpellcheckNotice(
                                                            "success",
                                                            `${entry.label} is ready to use.`,
                                                        );
                                                    })
                                                    .catch((error) => {
                                                        const message =
                                                            error instanceof
                                                            Error
                                                                ? error.message
                                                                : `Could not install ${entry.label}.`;
                                                        showSpellcheckNotice(
                                                            "error",
                                                            message,
                                                        );
                                                    })
                                                    .finally(() =>
                                                        setPendingCatalogAction(
                                                            (current) =>
                                                                current ===
                                                                `${entry.id}:install`
                                                                    ? null
                                                                    : current,
                                                        ),
                                                    );
                                            }}
                                            style={{
                                                minWidth: 86,
                                                borderRadius: 6,
                                                border: "1px solid var(--border)",
                                                backgroundColor:
                                                    "var(--bg-tertiary)",
                                                color: "var(--text-primary)",
                                                padding: "6px 10px",
                                                fontSize: 12,
                                                fontFamily: "inherit",
                                                cursor:
                                                    pendingInstall ||
                                                    pendingRemove
                                                        ? "not-allowed"
                                                        : "pointer",
                                                opacity:
                                                    pendingInstall ||
                                                    pendingRemove
                                                        ? 0.5
                                                        : 1,
                                            }}
                                        >
                                            {pendingInstall
                                                ? "Working..."
                                                : installLabel}
                                        </button>
                                        {entry.installed && (
                                            <button
                                                type="button"
                                                disabled={
                                                    pendingInstall ||
                                                    pendingRemove
                                                }
                                                onClick={() => {
                                                    setPendingCatalogAction(
                                                        `${entry.id}:remove`,
                                                    );
                                                    clearSpellcheckNotice();
                                                    void removeInstalledCatalogDictionary(
                                                        entry.id,
                                                    )
                                                        .then(() => {
                                                            showSpellcheckNotice(
                                                                "success",
                                                                `${entry.label} was removed.`,
                                                            );
                                                        })
                                                        .catch((error) => {
                                                            const message =
                                                                error instanceof
                                                                Error
                                                                    ? error.message
                                                                    : `Could not remove ${entry.label}.`;
                                                            showSpellcheckNotice(
                                                                "error",
                                                                message,
                                                            );
                                                        })
                                                        .finally(() =>
                                                            setPendingCatalogAction(
                                                                (current) =>
                                                                    current ===
                                                                    `${entry.id}:remove`
                                                                        ? null
                                                                        : current,
                                                            ),
                                                        );
                                                }}
                                                style={{
                                                    minWidth: 74,
                                                    borderRadius: 6,
                                                    border: "1px solid var(--border)",
                                                    backgroundColor:
                                                        "var(--bg-tertiary)",
                                                    color: "var(--text-secondary)",
                                                    padding: "6px 10px",
                                                    fontSize: 12,
                                                    fontFamily: "inherit",
                                                    cursor:
                                                        pendingInstall ||
                                                        pendingRemove
                                                            ? "not-allowed"
                                                            : "pointer",
                                                    opacity:
                                                        pendingInstall ||
                                                        pendingRemove
                                                            ? 0.5
                                                            : 1,
                                                }}
                                            >
                                                {pendingRemove
                                                    ? "Working..."
                                                    : "Remove"}
                                            </button>
                                        )}
                                    </div>
                                }
                            />
                        );
                    })}
                </>
            )}
            {spellcheckLastError && (
                <div
                    style={{
                        marginTop: 10,
                        fontSize: 11,
                        color: "#c84b4b",
                        lineHeight: 1.5,
                    }}
                >
                    {spellcheckLastError}
                </div>
            )}
            {spellcheckCatalogNotice && (
                <div
                    style={{
                        marginTop: spellcheckLastError ? 6 : 10,
                        fontSize: 11,
                        color:
                            spellcheckCatalogNotice.tone === "error"
                                ? "#c84b4b"
                                : "var(--text-secondary)",
                        lineHeight: 1.5,
                    }}
                >
                    {spellcheckCatalogNotice.message}
                </div>
            )}
        </div>
    );
}

function VaultSettings({ searchQuery }: { searchQuery: SettingsSearchQuery }) {
    const vaultStorePath = useVaultStore((s) => s.vaultPath);
    const vaultPath = vaultStorePath ?? readSearchParam("vault");
    const [recents, setRecents] = useState<RecentVault[]>(() =>
        getRecentVaults(),
    );
    const [confirmPath, setConfirmPath] = useState<string | null>(null);
    const [recentSearch, setRecentSearch] = useState("");

    const normalizedRecentSearch = recentSearch.trim().toLowerCase();
    const filteredRecents = recents.filter((vault) => {
        const matchesLocalSearch =
            !normalizedRecentSearch ||
            vault.name.toLowerCase().includes(normalizedRecentSearch) ||
            vault.path.toLowerCase().includes(normalizedRecentSearch);

        return (
            matchesLocalSearch &&
            matchesSettingsSearch(
                searchQuery,
                "Recent Vaults",
                vault.name,
                vault.path,
            )
        );
    });
    const showCurrentVault = sectionHasSettingsSearchMatches(
        searchQuery,
        "Current Vault",
        [
            [
                "Vault path",
                "The folder currently open as your vault.",
                vaultPath,
                "No vault open",
            ],
        ],
    );
    const showRecentVaults =
        recents.length === 0
            ? matchesSettingsSearch(
                  searchQuery,
                  "Recent Vaults",
                  "No recent vaults.",
              )
            : matchesSettingsSearch(
                  searchQuery,
                  "Recent Vaults",
                  "Search recent vaults",
                  "Clear recent vaults",
              ) || filteredRecents.length > 0;

    if (!showCurrentVault && !showRecentVaults) {
        return <EmptyPanelSearchResult />;
    }

    const handleRemoveVault = async (path: string) => {
        await removeVaultFromList(path);
        setRecents(getRecentVaults());
        setConfirmPath(null);
    };

    const handleClearRecents = () => {
        clearRecentVaults();
        setRecents([]);
        setRecentSearch("");
        setConfirmPath(null);
    };

    return (
        <div>
            {showCurrentVault ? <SectionLabel>Current Vault</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Current Vault"
                label="Vault path"
                description="The folder currently open as your vault."
                keywords={[vaultPath, "No vault open"]}
                control={
                    <span
                        style={{
                            fontSize: 11,
                            color: "var(--text-secondary)",
                            fontFamily: "monospace",
                            maxWidth: 220,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "block",
                        }}
                        title={vaultPath ?? ""}
                    >
                        {vaultPath ?? "No vault open"}
                    </span>
                }
            />

            {showRecentVaults ? <SectionLabel>Recent Vaults</SectionLabel> : null}
            {showRecentVaults && recents.length === 0 ? (
                <p
                    style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        padding: "12px 0",
                    }}
                >
                    No recent vaults.
                </p>
            ) : null}
            {showRecentVaults && recents.length > 0 ? (
                <>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            borderRadius: 7,
                            padding: "5px 10px",
                            marginBottom: 10,
                        }}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            style={{ opacity: 0.4, flexShrink: 0 }}
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
                            value={recentSearch}
                            onChange={(event) =>
                                setRecentSearch(event.target.value)
                            }
                            aria-label="Search recent vaults"
                            placeholder="Search recent vaults…"
                            style={{
                                flex: 1,
                                border: "none",
                                background: "transparent",
                                fontSize: 12,
                                color: "var(--text-primary)",
                                outline: "none",
                                fontFamily: "inherit",
                            }}
                        />
                        <span
                            style={{
                                fontSize: 11,
                                color: "var(--text-secondary)",
                                fontFamily: "monospace",
                                flexShrink: 0,
                            }}
                        >
                            {filteredRecents.length}/{recents.length}
                        </span>
                    </div>
                    <div
                        role="list"
                        aria-label="Recent vaults"
                        style={{
                            maxHeight: 420,
                            overflowY: "auto",
                            borderTop: "1px solid var(--border)",
                            borderBottom: "1px solid var(--border)",
                        }}
                    >
                        {filteredRecents.length === 0 ? (
                            <p
                                style={{
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                    padding: "12px 0",
                                }}
                            >
                                No vaults match your search.
                            </p>
                        ) : (
                            filteredRecents.map((vault) => (
                                <div
                                    key={vault.path}
                                    role="listitem"
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        padding: "8px 0",
                                        borderBottom: "1px solid var(--border)",
                                        gap: 8,
                                    }}
                                >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div
                                            style={{
                                                fontSize: 13,
                                                color: "var(--text-primary)",
                                                fontWeight: 500,
                                            }}
                                        >
                                            {vault.name}
                                        </div>
                                        <div
                                            style={{
                                                fontSize: 11,
                                                color: "var(--text-secondary)",
                                                fontFamily: "monospace",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {vault.path}
                                        </div>
                                    </div>
                                    {confirmPath === vault.path ? (
                                        <div
                                            style={{
                                                display: "flex",
                                                gap: 4,
                                                flexShrink: 0,
                                            }}
                                        >
                                            <button
                                                onClick={() =>
                                                    handleRemoveVault(
                                                        vault.path,
                                                    )
                                                }
                                                style={{
                                                    fontSize: 11,
                                                    color: "#fff",
                                                    backgroundColor: "#ef4444",
                                                    border: "none",
                                                    borderRadius: 5,
                                                    padding: "3px 8px",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Confirm
                                            </button>
                                            <button
                                                onClick={() =>
                                                    setConfirmPath(null)
                                                }
                                                style={{
                                                    fontSize: 11,
                                                    color: "var(--text-secondary)",
                                                    backgroundColor:
                                                        "var(--bg-tertiary)",
                                                    border: "1px solid var(--border)",
                                                    borderRadius: 5,
                                                    padding: "3px 8px",
                                                    cursor: "pointer",
                                                }}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() =>
                                                setConfirmPath(vault.path)
                                            }
                                            title="Remove vault from list and delete cached data"
                                            style={{
                                                width: 24,
                                                height: 24,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: 5,
                                                border: "none",
                                                background: "transparent",
                                                cursor: "pointer",
                                                color: "var(--text-secondary)",
                                                opacity: 0.5,
                                                flexShrink: 0,
                                            }}
                                            onMouseEnter={(e) => {
                                                e.currentTarget.style.opacity =
                                                    "1";
                                                e.currentTarget.style.color =
                                                    "#ef4444";
                                                e.currentTarget.style.backgroundColor =
                                                    "var(--bg-tertiary)";
                                            }}
                                            onMouseLeave={(e) => {
                                                e.currentTarget.style.opacity =
                                                    "0.5";
                                                e.currentTarget.style.color =
                                                    "var(--text-secondary)";
                                                e.currentTarget.style.backgroundColor =
                                                    "transparent";
                                            }}
                                        >
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 16 16"
                                                fill="none"
                                            >
                                                <path
                                                    d="M4 4l8 8M12 4l-8 8"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                    strokeLinecap="round"
                                                />
                                            </svg>
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                    <div style={{ paddingTop: 12 }}>
                        <button
                            onClick={handleClearRecents}
                            style={{
                                fontSize: 12,
                                color: "#ef4444",
                                background: "transparent",
                                border: "1px solid color-mix(in srgb, #ef4444 40%, transparent)",
                                borderRadius: 6,
                                padding: "4px 10px",
                                cursor: "pointer",
                            }}
                        >
                            Clear recent vaults
                        </button>
                    </div>
                </>
            ) : null}
        </div>
    );
}

type UpdateStateKind =
    | "not-configured"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "up-to-date"
    | "error";

const MONO_FONT_STACK =
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const RELEASE_NOTES_URL =
    "https://github.com/jsgrrchg/NeverWrite/releases/latest";
const REPOSITORY_ISSUES_URL = "https://github.com/jsgrrchg/NeverWrite/issues";
const REPOSITORY_DISCUSSIONS_URL =
    "https://github.com/jsgrrchg/NeverWrite/discussions";
const NEW_REPOSITORY_ISSUE_URL =
    "https://github.com/jsgrrchg/NeverWrite/issues/new";
const NEW_REPOSITORY_DISCUSSION_URL =
    "https://github.com/jsgrrchg/NeverWrite/discussions/new/choose";
const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/jsgrrchg";
const GITHUB_SPONSORS_URL = "https://github.com/sponsors/jsgrrchg";

function UpdatesSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const status = useAppUpdateStore((state) => state.status);
    const loading = useAppUpdateStore((state) => state.loading);
    const checking = useAppUpdateStore((state) => state.checking);
    const installing = useAppUpdateStore((state) => state.installing);
    const error = useAppUpdateStore((state) => state.error);
    const hasChecked = useAppUpdateStore((state) => state.hasChecked);
    const lastCheckedAt = useAppUpdateStore((state) => state.lastCheckedAt);
    const initialize = useAppUpdateStore((state) => state.initialize);
    const checkNow = useAppUpdateStore((state) => state.checkNow);
    const installAvailableUpdate = useAppUpdateStore(
        (state) => state.installAvailableUpdate,
    );
    const [sensitiveState, setSensitiveState] = useState<SensitiveUpdateState>({
        items: [],
        requiresConfirmation: false,
    });
    const [confirmInstall, setConfirmInstall] = useState(false);

    useEffect(() => {
        void initialize({ backgroundCheck: true });
    }, [initialize]);

    useEffect(() => {
        let cancelled = false;

        const refreshSensitiveState = async () => {
            const next = await readSensitiveUpdateState();
            if (!cancelled) {
                setSensitiveState(next);
            }
        };

        void refreshSensitiveState();
        const unsubscribeStorage = subscribeSafeStorage(({ key }) => {
            if (key !== null && !isWindowOperationalStateStorageKey(key)) {
                return;
            }
            void refreshSensitiveState();
        });
        const onFocus = () => {
            void refreshSensitiveState();
        };
        window.addEventListener("focus", onFocus);

        return () => {
            cancelled = true;
            unsubscribeStorage();
            window.removeEventListener("focus", onFocus);
        };
    }, []);

    const anyBusy = loading || checking || installing;
    const effectiveError = error ?? null;
    const updaterConfigured = Boolean(status?.enabled);
    const automaticUpdatesDescription = updaterConfigured
        ? "NeverWrite does not update automatically. It only downloads and installs updates when you choose it."
        : "Not available in this build.";
    const stateKind = resolveUpdateStateKind({
        checking,
        installing,
        hasUpdate: Boolean(status?.update),
        hasChecked,
        hasError: Boolean(effectiveError),
        configured: updaterConfigured,
    });
    const currentVersionLabel = formatVersionPillLabel(
        status?.currentVersion ?? "",
    );
    const lastCheckedLabel = formatLastCheckedLabel(lastCheckedAt);
    const canInstallUpdate = Boolean(status?.update) && !anyBusy;
    const canCheckForUpdates = updaterConfigured && !anyBusy;
    const showConfirmInstall =
        confirmInstall && sensitiveState.requiresConfirmation;

    const triggerInstall = () => {
        void (async () => {
            const nextSensitiveState = await readSettledSensitiveUpdateState();
            setSensitiveState(nextSensitiveState);
            if (nextSensitiveState.requiresConfirmation && !showConfirmInstall) {
                setConfirmInstall(true);
                return;
            }
            await installAvailableUpdate().catch(() => {});
        })();
    };

    const primaryAction = status?.update
        ? {
              label: installing
                  ? "installing..."
                  : checking
                    ? "checking..."
                    : "download and install",
              active: true,
              disabled: !canInstallUpdate,
              onClick: triggerInstall,
          }
        : {
              label: getCheckForUpdatesLabel({ checking, installing }),
              active: false,
              disabled: !canCheckForUpdates,
              onClick: () => {
                  setConfirmInstall(false);
                  void checkNow();
              },
          };

    const statusDescription = resolveStatusDescription({
        configured: updaterConfigured,
        message: status?.message ?? null,
        error: effectiveError,
        hasChecked,
        stateKind,
    });
    const updateVersionLabel = status?.update
        ? formatVersionPillLabel(status.update.version)
        : null;
    const updateDateLabel = formatUpdateDate(status?.update?.date ?? undefined);
    const showVersion = sectionHasSettingsSearchMatches(
        searchQuery,
        "Version",
        [
            [
                "Current version",
                `You're on ${currentVersionLabel}. Last checked ${lastCheckedLabel}.`,
                currentVersionLabel,
                primaryAction.label,
                "release notes",
                "changelog",
                "github",
            ],
            [
                "Channel",
                "Release track used when querying the update feed.",
                status?.channel,
                "stable",
            ],
            [
                "Automatic updates",
                automaticUpdatesDescription,
                "manual install",
                "no automatic install",
            ],
            [
                "Update status",
                statusDescription,
                stateKind,
                status?.message,
                effectiveError,
                updateVersionLabel,
            ],
        ],
    );
    const showAvailableUpdate =
        status?.update != null &&
        sectionHasSettingsSearchMatches(searchQuery, "Available update", [
            ["Version", updateVersionLabel],
            ["Published", updateDateLabel, status.update.date],
            [status.update.body],
        ]);
    const showInterruptWarning =
        showVersion &&
        showConfirmInstall &&
        matchesSettingsSearch(
            searchQuery,
            "Version",
            "This update may interrupt active work.",
            ...sensitiveState.items.flatMap((item) => [
                item.title,
                ...item.details,
            ]),
        );

    if (!showVersion && !showAvailableUpdate) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showVersion ? <SectionLabel>Version</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Current version"
                description={`You're on ${currentVersionLabel}. Last checked ${lastCheckedLabel}.`}
                keywords={[
                    currentVersionLabel,
                    primaryAction.label,
                    "release notes",
                    "changelog",
                    "github",
                ]}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            gap: 8,
                        }}
                    >
                        <VersionPill label={currentVersionLabel} />
                        <SettingsActionButton
                            active={false}
                            onClick={() => {
                                void openUrl(RELEASE_NOTES_URL);
                            }}
                        >
                            release notes
                        </SettingsActionButton>
                        <SettingsActionButton
                            active={primaryAction.active}
                            disabled={primaryAction.disabled}
                            onClick={primaryAction.onClick}
                        >
                            {primaryAction.label}
                        </SettingsActionButton>
                    </div>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Channel"
                description="Release track used when querying the update feed."
                keywords={[status?.channel, "stable"]}
                control={<VersionPill label={status?.channel ?? "stable"} />}
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Automatic updates"
                description={automaticUpdatesDescription}
                keywords={["manual install", "no automatic install"]}
                control={
                    <VersionPill label={updaterConfigured ? "Manual" : "Off"} />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Version"
                label="Update status"
                description={statusDescription}
                keywords={[
                    stateKind,
                    status?.message,
                    effectiveError,
                    updateVersionLabel,
                ]}
                control={
                    <div
                        style={{
                            alignItems: "center",
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 8,
                            justifyContent: "flex-end",
                        }}
                    >
                        <UpdateStatusBadge kind={stateKind} />
                        {status?.update ? (
                            <span
                                style={{
                                    color: "var(--text-secondary)",
                                    fontFamily: MONO_FONT_STACK,
                                    fontSize: 10,
                                }}
                            >
                                {`target ${formatVersionPillLabel(status.update.version)}`}
                            </span>
                        ) : null}
                    </div>
                }
            />

            {showInterruptWarning ? (
                <div
                    style={{
                        marginTop: 12,
                        padding: "10px 12px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg-secondary)",
                    }}
                >
                    <div
                        style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--text-primary)",
                            marginBottom: 6,
                        }}
                    >
                        This update may interrupt active work.
                    </div>
                    <div
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            lineHeight: 1.5,
                        }}
                    >
                        {sensitiveState.items.map((item) => (
                            <div key={item.key} style={{ marginTop: 4 }}>
                                <span style={{ fontWeight: 500 }}>
                                    {item.title}:
                                </span>{" "}
                                {item.details.join(", ")}
                            </div>
                        ))}
                    </div>
                    <div
                        style={{
                            marginTop: 10,
                            display: "flex",
                            gap: 8,
                        }}
                    >
                        <SettingsActionButton
                            active
                            disabled={installing}
                            onClick={() => {
                                void (async () => {
                                    const nextSensitiveState =
                                        await readSensitiveUpdateState();
                                    setSensitiveState(nextSensitiveState);
                                    await installAvailableUpdate().catch(
                                        () => {},
                                    );
                                })();
                            }}
                        >
                            {installing ? "installing..." : "install anyway"}
                        </SettingsActionButton>
                        <SettingsActionButton
                            active={false}
                            disabled={installing}
                            onClick={() => setConfirmInstall(false)}
                        >
                            cancel
                        </SettingsActionButton>
                    </div>
                </div>
            ) : null}

            {showAvailableUpdate && status?.update ? (
                <>
                    <SectionLabel>Available update</SectionLabel>
                    <SearchableRow
                        searchQuery={searchQuery}
                        section="Available update"
                        label="Version"
                        keywords={[updateVersionLabel]}
                        control={
                            <VersionPill
                                label={formatVersionPillLabel(
                                    status.update.version,
                                )}
                            />
                        }
                    />
                    <SearchableRow
                        searchQuery={searchQuery}
                        section="Available update"
                        label="Published"
                        keywords={[updateDateLabel, status.update.date]}
                        control={
                            <span
                                style={{
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                    fontVariantNumeric: "tabular-nums",
                                }}
                            >
                                {formatUpdateDate(status.update.date ?? undefined)}
                            </span>
                        }
                    />
                    {status.update.body?.trim() ? (
                        <div
                            style={{
                                marginTop: 12,
                                padding: 12,
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                background: "var(--bg-secondary)",
                            }}
                        >
                            <div
                                style={{
                                    fontSize: 13,
                                    lineHeight: 1.6,
                                    color: "var(--text-primary)",
                                }}
                            >
                                <MarkdownContent
                                    content={status.update.body.trim()}
                                    pillMetrics={getChatPillMetrics(13)}
                                    chatFontSize={13}
                                />
                            </div>
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

function VersionPill({ label }: { label: string }) {
    return (
        <span
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--accent) 14%, transparent)",
                borderRadius: 4,
                color: "var(--accent)",
                fontFamily: MONO_FONT_STACK,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                padding: "2px 6px",
                textTransform: "uppercase",
            }}
        >
            {label}
        </span>
    );
}

function UpdateStatusBadge({ kind }: { kind: UpdateStateKind }) {
    const { backgroundColor, color, label } = getUpdateStatusPresentation(kind);
    return (
        <span
            style={{
                backgroundColor,
                borderRadius: 4,
                color,
                fontFamily: MONO_FONT_STACK,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                padding: "2px 6px",
                textTransform: "uppercase",
            }}
        >
            {label}
        </span>
    );
}

function SettingsActionButton({
    children,
    active,
    disabled,
    onClick,
}: {
    children: string;
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="nw-settings-action-btn"
            style={{
                backgroundColor: active
                    ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                    : "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: active ? "var(--accent)" : "var(--text-primary)",
                cursor: disabled ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                opacity: disabled ? 0.5 : 1,
                padding: "5px 10px",
                whiteSpace: "nowrap",
            }}
        >
            {children}
        </button>
    );
}

function FeedbackSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const showCommunity = sectionHasSettingsSearchMatches(
        searchQuery,
        "Community",
        [
            [
                "Issues",
                "Browse open bug reports, feature requests, and support threads on GitHub.",
                "github",
                "bugs",
                "feature requests",
            ],
            [
                "Discussions",
                "Read community questions, ideas, and longer-form conversations on GitHub.",
                "github",
                "community",
                "questions",
                "ideas",
            ],
        ],
    );
    const showCreate = sectionHasSettingsSearchMatches(searchQuery, "Create", [
        [
            "Create issue",
            "Open GitHub to file a bug report or request a focused change.",
            "github",
            "report bug",
            "request feature",
        ],
        [
            "Start discussion",
            "Open GitHub to start a broader question, idea, or product conversation.",
            "github",
            "question",
            "idea",
        ],
    ]);

    if (!showCommunity && !showCreate) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showCommunity ? <SectionLabel>Community</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Community"
                label="Issues"
                description="Browse open bug reports, feature requests, and support threads on GitHub."
                keywords={["github", "bugs", "feature requests"]}
                control={
                    <SettingsActionButton
                        active={false}
                        onClick={() => {
                            void openUrl(REPOSITORY_ISSUES_URL);
                        }}
                    >
                        open issues
                    </SettingsActionButton>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Community"
                label="Discussions"
                description="Read community questions, ideas, and longer-form conversations on GitHub."
                keywords={["github", "community", "questions", "ideas"]}
                control={
                    <SettingsActionButton
                        active={false}
                        onClick={() => {
                            void openUrl(REPOSITORY_DISCUSSIONS_URL);
                        }}
                    >
                        open discussions
                    </SettingsActionButton>
                }
            />

            {showCreate ? <SectionLabel>Create</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Create"
                label="Create issue"
                description="Open GitHub to file a bug report or request a focused change."
                keywords={["github", "report bug", "request feature"]}
                control={
                    <SettingsActionButton
                        active
                        onClick={() => {
                            void openUrl(NEW_REPOSITORY_ISSUE_URL);
                        }}
                    >
                        new issue
                    </SettingsActionButton>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Create"
                label="Start discussion"
                description="Open GitHub to start a broader question, idea, or product conversation."
                keywords={["github", "question", "idea"]}
                control={
                    <SettingsActionButton
                        active
                        onClick={() => {
                            void openUrl(NEW_REPOSITORY_DISCUSSION_URL);
                        }}
                    >
                        new discussion
                    </SettingsActionButton>
                }
            />
        </div>
    );
}

function SponsorsSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const showSupport = sectionHasSettingsSearchMatches(
        searchQuery,
        "Support",
        [
            [
                "Buy Me a Coffee",
                "Support NeverWrite development with a one-time contribution.",
                "coffee",
                "donate",
                "support",
            ],
            [
                "GitHub Sponsors",
                "Sponsor ongoing NeverWrite maintenance and development through GitHub.",
                "github",
                "sponsor",
                "funding",
            ],
            [
                "AI tooling is moving fast, and NeverWrite moves with it.",
                "Support helps fund weekly maintenance, expanded provider compatibility, runtime stability, security hardening, and safer agent review workflows.",
                "runtime stability",
                "security hardening",
                "provider compatibility",
            ],
        ],
    );

    if (!showSupport) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            <SectionLabel>Support</SectionLabel>
            <SearchableRow
                searchQuery={searchQuery}
                section="Support"
                label="Buy Me a Coffee"
                description="Support NeverWrite development with a one-time contribution."
                keywords={["coffee", "donate", "support"]}
                control={
                    <SettingsActionButton
                        active
                        onClick={() => {
                            void openUrl(BUY_ME_A_COFFEE_URL);
                        }}
                    >
                        buy coffee
                    </SettingsActionButton>
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Support"
                label="GitHub Sponsors"
                description="Sponsor ongoing NeverWrite maintenance and development through GitHub."
                keywords={["github", "sponsor", "funding"]}
                control={
                    <SettingsActionButton
                        active
                        onClick={() => {
                            void openUrl(GITHUB_SPONSORS_URL);
                        }}
                    >
                        sponsor
                    </SettingsActionButton>
                }
            />
            <div
                style={{
                    marginTop: 14,
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background:
                        "color-mix(in srgb, var(--accent) 8%, var(--bg-secondary))",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    lineHeight: 1.55,
                    padding: "12px 14px",
                }}
            >
                <span style={{ fontWeight: 600 }}>
                    AI tooling is moving fast, and NeverWrite moves with it.
                </span>{" "}
                Support helps fund weekly maintenance, expanded provider
                compatibility, runtime stability, security hardening, and safer
                agent review workflows.
            </div>
        </div>
    );
}

function resolveUpdateStateKind({
    checking,
    installing,
    hasUpdate,
    hasChecked,
    hasError,
    configured,
}: {
    checking: boolean;
    installing: boolean;
    hasUpdate: boolean;
    hasChecked: boolean;
    hasError: boolean;
    configured: boolean;
}): UpdateStateKind {
    if (hasError) return "error";
    if (!configured) return "not-configured";
    if (installing) return "downloading";
    if (checking) return "checking";
    if (hasUpdate) return "available";
    if (hasChecked) return "up-to-date";
    return "idle";
}

function getUpdateStatusPresentation(kind: UpdateStateKind): {
    backgroundColor: string;
    color: string;
    label: string;
} {
    switch (kind) {
        case "checking":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--accent) 12%, transparent)",
                color: "var(--accent)",
                label: "Checking",
            };
        case "available":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--accent) 14%, transparent)",
                color: "var(--accent)",
                label: "Available",
            };
        case "downloading":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--accent) 14%, transparent)",
                color: "var(--accent)",
                label: "Installing",
            };
        case "up-to-date":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
                color: "var(--text-secondary)",
                label: "Up to date",
            };
        case "error":
            return {
                backgroundColor:
                    "color-mix(in srgb, #ef4444 14%, transparent)",
                color: "#ef4444",
                label: "Error",
            };
        case "not-configured":
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
                color: "var(--text-secondary)",
                label: "Not configured",
            };
        case "idle":
        default:
            return {
                backgroundColor:
                    "color-mix(in srgb, var(--accent) 10%, transparent)",
                color: "var(--accent)",
                label: "Idle",
            };
    }
}

function getCheckForUpdatesLabel({
    checking,
    installing,
}: {
    checking: boolean;
    installing: boolean;
}): string {
    if (installing) return "installing...";
    if (checking) return "checking...";
    return "check for updates";
}

function formatVersionPillLabel(version: string): string {
    const normalized = version.trim();
    return normalized.length > 0 ? `v${normalized}` : "unknown";
}

function formatLastCheckedLabel(lastCheckedAt: number | null): string {
    if (lastCheckedAt == null) return "never";

    const diffMs = Date.now() - lastCheckedAt;
    if (diffMs < 60_000) return "just now";

    const diffMinutes = Math.floor(diffMs / 60_000);
    if (diffMinutes < 60) return `${diffMinutes} min ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hr ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    }

    return new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(new Date(lastCheckedAt));
}

function resolveStatusDescription({
    configured,
    message,
    error,
    hasChecked,
    stateKind,
}: {
    configured: boolean;
    message: string | null;
    error: string | null;
    hasChecked: boolean;
    stateKind: UpdateStateKind;
}): string {
    if (error) return error;
    if (message) return message;
    if (!configured) {
        return "Automatic updates are not available in this build.";
    }
    switch (stateKind) {
        case "available":
            return "A new version is ready to download.";
        case "downloading":
            return "Installing the latest release.";
        case "checking":
            return "Contacting the release feed...";
        case "up-to-date":
            return "You're running the latest release.";
        case "idle":
        default:
            return hasChecked
                ? "Waiting for the next manual check."
                : "Check manually to see if a new version is available.";
    }
}

const CLAUDE_CODE_MODEL_OPTIONS = [
    { value: "", label: "Default (Claude Code decides)" },
    { value: "claude-opus-4-7", label: "Opus 4.7 — most capable" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
    { value: "claude-haiku-4-5", label: "Haiku 4.5 — fast" },
] as const;

function TerminalSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const {
        terminalFontFamily,
        terminalFontSize,
        claudeCodeOptimized,
        claudeCodeSkipPermissions,
        claudeCodeModel,
        claudeCodeContinueSession,
        setSetting,
    } = useSettingsStore();

    const [claudeCodeReady, setClaudeCodeReady] = useState(false);
    useEffect(() => {
        void checkClaudeCodeInstalled().then(setClaudeCodeReady);
    }, []);

    const showFont = sectionHasSettingsSearchMatches(searchQuery, "Font", [
        [
            "Font family",
            "Monospace font used in the terminal. Must be installed on this system. Nerd Fonts are supported.",
        ],
        ["Font size", "Terminal text size in pixels."],
    ]);
    const showShell = sectionHasSettingsSearchMatches(
        searchQuery,
        "Shell Environment",
        [
            [
                "Fullscreen rendering",
                "Sets CLAUDE_CODE_NO_FLICKER=1 when opening a new terminal. Improves rendering stability for Claude Code but disables scrollback. Only applies to newly opened terminals.",
            ],
        ],
    );
    const showClaudeCode =
        claudeCodeReady &&
        sectionHasSettingsSearchMatches(searchQuery, "Claude Code", [
            [
                "Skip permissions",
                "Passes --dangerously-skip-permissions. Claude Code will not ask for approval before running tools. Only enable if you trust the session context.",
                "yolo",
                "dangerously-skip-permissions",
            ],
            [
                "Model",
                "Which Claude model to use. Leave blank to let Claude Code choose.",
                "opus",
                "sonnet",
                "haiku",
                ...CLAUDE_CODE_MODEL_OPTIONS.map((o) => o.label),
            ],
            [
                "Continue last session",
                "Passes --continue. Resumes your most recent Claude Code conversation instead of starting fresh.",
            ],
        ]);

    if (!showFont && !showShell && !showClaudeCode) {
        return <EmptyPanelSearchResult />;
    }

    const selectStyle = {
        width: 220,
        padding: "6px 8px",
        fontSize: 12,
        fontFamily: "inherit",
        borderRadius: 6,
        border: "1px solid var(--border)",
        backgroundColor: "var(--bg-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
        outline: "none",
    } as const;

    return (
        <div>
            {showFont ? <SectionLabel>Font</SectionLabel> : null}
            {showFont && (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Font"
                    label="Font family"
                    description="Monospace font for the terminal. Must be installed on this system. Nerd Fonts are supported."
                    keywords={["monospace", "nerd font", "firacode", "jetbrains"]}
                    control={
                        <input
                            type="text"
                            placeholder="e.g. FiraCode Nerd Font"
                            value={terminalFontFamily}
                            onChange={(e) =>
                                setSetting("terminalFontFamily", e.target.value)
                            }
                            style={{
                                width: 200,
                                padding: "6px 8px",
                                fontSize: 12,
                                fontFamily: "inherit",
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-secondary)",
                                color: "var(--text-primary)",
                                outline: "none",
                            }}
                        />
                    }
                />
            )}
            {showFont && (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Font"
                    label="Font size"
                    description="Terminal text size in pixels."
                    control={
                        <NumberStepper
                            value={terminalFontSize}
                            min={8}
                            max={24}
                            onChange={(v) => setSetting("terminalFontSize", v)}
                        />
                    }
                />
            )}
            {showShell ? (
                <SectionLabel>Shell Environment</SectionLabel>
            ) : null}
            {showShell && (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Shell Environment"
                    label="Fullscreen rendering (experimental)"
                    description="Sets CLAUDE_CODE_NO_FLICKER=1. Reduces flicker in Claude Code but disables scrollback. Applies to new terminals only."
                    keywords={["claude code", "flicker", "CLAUDE_CODE_NO_FLICKER"]}
                    control={
                        <Toggle
                            value={claudeCodeOptimized}
                            onChange={(value) =>
                                setSetting("claudeCodeOptimized", value)
                            }
                        />
                    }
                />
            )}
            {showClaudeCode ? (
                <SectionLabel>Claude Code</SectionLabel>
            ) : null}
            {showClaudeCode && (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Claude Code"
                    label="Skip permissions"
                    description="Passes --dangerously-skip-permissions. Claude Code will not ask for approval before running tools or writing files. Only enable if you trust the session context."
                    keywords={["yolo", "dangerously-skip-permissions", "permissions"]}
                    control={
                        <Toggle
                            value={claudeCodeSkipPermissions}
                            onChange={(v) =>
                                setSetting("claudeCodeSkipPermissions", v)
                            }
                        />
                    }
                />
            )}
            {showClaudeCode && (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Claude Code"
                    label="Model"
                    description="Which Claude model powers each session. Leave on Default to let Claude Code choose based on your subscription."
                    keywords={["opus", "sonnet", "haiku", "model", "claude"]}
                    control={
                        <select
                            value={claudeCodeModel}
                            onChange={(e) =>
                                setSetting("claudeCodeModel", e.target.value)
                            }
                            style={selectStyle}
                        >
                            {CLAUDE_CODE_MODEL_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    }
                />
            )}
            {showClaudeCode && (
                <SearchableRow
                    searchQuery={searchQuery}
                    section="Claude Code"
                    label="Continue last session"
                    description="Passes --continue. Resumes your most recent Claude Code conversation instead of starting a new one."
                    keywords={["resume", "continue", "session", "history"]}
                    control={
                        <Toggle
                            value={claudeCodeContinueSession}
                            onChange={(v) =>
                                setSetting("claudeCodeContinueSession", v)
                            }
                        />
                    }
                />
            )}
        </div>
    );
}

function FileTreeSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const {
        fileTreeContentMode,
        fileTreeShowExtensions,
        fileTreeShowDocumentStatus,
        fileTreeExtensionFilter,
        setSetting,
    } = useSettingsStore();
    const showFileTree = sectionHasSettingsSearchMatches(
        searchQuery,
        "File Tree",
        [
            [
                "Show all vault files",
                "Display every file in the vault tree, beyond the curated writing and media file set.",
                "File-oriented search is active",
                "Search Files & Notes",
                "wikilink suggestions",
                "@ mentions",
            ],
            [
                "Show file extensions",
                "Display full file names with their extensions in the vault tree.",
            ],
            [
                "Show document status",
                "Show a colored dot for the frontmatter status of each note.",
            ],
            [
                "File extension filter",
                "Optional allowlist for the file tree. Leave empty to use the current content mode.",
                "allowlist",
                "pdf, txt, csv",
            ],
        ],
    );

    if (!showFileTree) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showFileTree ? <SectionLabel>File Tree</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="File Tree"
                label="Show all vault files"
                description="Display every vault file, beyond the curated writing and media set. With this off, Markdown, Mermaid, PDFs, images, Excalidraw, CSV, TXT, and HTML files are shown."
                keywords={[
                    "File-oriented search is active",
                    "Search Files & Notes",
                    "wikilink suggestions",
                    "@ mentions",
                ]}
                control={
                    <Toggle
                        value={fileTreeContentMode === "all_files"}
                        onChange={(value) =>
                            setSetting(
                                "fileTreeContentMode",
                                value ? "all_files" : "notes_only",
                            )
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="File Tree"
                label="Show file extensions"
                description="Display full file names with their extensions in the vault tree."
                control={
                    <Toggle
                        value={fileTreeShowExtensions}
                        onChange={(value) =>
                            setSetting("fileTreeShowExtensions", value)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="File Tree"
                label="Show document status"
                description="Show a colored dot for the frontmatter status of each note."
                control={
                    <Toggle
                        value={fileTreeShowDocumentStatus}
                        onChange={(value) =>
                            setSetting("fileTreeShowDocumentStatus", value)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="File Tree"
                label="File extension filter"
                description="Optional allowlist for the file tree and file pickers. When set, it overrides Show all vault files; leave empty to use the current mode."
                keywords={["allowlist", "pdf, txt, csv"]}
                control={
                    <ExtensionFilterInput
                        value={fileTreeExtensionFilter}
                        onChange={(value) =>
                            setSetting("fileTreeExtensionFilter", value)
                        }
                    />
                }
            />
            {showFileTree && fileTreeContentMode === "all_files" && (
                <div
                    className="mx-4 mt-3 rounded-lg px-3 py-2 text-[12px]"
                    style={{
                        border: "1px solid var(--border)",
                        backgroundColor: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                    }}
                >
                    Normal mode already includes Markdown notes plus curated
                    writing and media files. All-files mode expands the file
                    tree, New Tab, `@` mentions, and wikilink suggestions to
                    technical project files where supported.
                </div>
            )}
        </div>
    );
}

function ShortcutsSettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    const platform = getDesktopPlatform();
    const shortcuts = getShortcutSettingsEntries(platform);
    const filteredShortcuts = shortcuts.filter((shortcut) =>
        matchesSettingsSearch(
            searchQuery,
            "Keyboard shortcuts",
            shortcut.category,
            shortcut.label,
            shortcut.shortcut,
        ),
    );

    const grouped = filteredShortcuts.reduce<Record<string, typeof shortcuts>>(
        (acc, s) => {
            (acc[s.category] ??= []).push(s);
            return acc;
        },
        {},
    );

    if (shortcuts.length === 0) {
        return (
            <div>
                <SectionLabel>Shortcuts</SectionLabel>
                <p
                    style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        padding: "12px 0",
                    }}
                >
                    No shortcuts registered yet.
                </p>
            </div>
        );
    }

    if (filteredShortcuts.length === 0) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {Object.entries(grouped).map(([cat, items]) => (
                <div key={cat}>
                    <SectionLabel>{cat}</SectionLabel>
                    {items.map((item) => (
                        <div
                            key={item.label}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "9px 0",
                                borderBottom: "1px solid var(--border)",
                            }}
                        >
                            <span
                                style={{
                                    fontSize: 13,
                                    color: "var(--text-primary)",
                                }}
                            >
                                {item.label}
                            </span>
                            <kbd
                                style={{
                                    fontSize: 11,
                                    fontFamily: "inherit",
                                    color: "var(--text-secondary)",
                                    backgroundColor: "var(--bg-tertiary)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 5,
                                    padding: "2px 7px",
                                }}
                            >
                                {item.shortcut}
                            </kbd>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

function AISettings({
    searchQuery,
    vaultPath,
}: {
    searchQuery: SettingsSearchQuery;
    vaultPath: string | null;
}) {
    const inlineReviewEnabled = useSettingsStore((s) => s.inlineReviewEnabled);
    const setSetting = useSettingsStore((s) => s.setSetting);
    const requireCmdEnterToSend = useChatStore((s) => s.requireCmdEnterToSend);
    const toggleRequireCmdEnterToSend = useChatStore(
        (s) => s.toggleRequireCmdEnterToSend,
    );
    const contextUsageBarEnabled = useChatStore(
        (s) => s.contextUsageBarEnabled,
    );
    const setContextUsageBarEnabled = useChatStore(
        (s) => s.setContextUsageBarEnabled,
    );
    const toolActivityDisplayMode = useChatStore(
        (s) => s.toolActivityDisplayMode,
    );
    const setToolActivityDisplayMode = useChatStore(
        (s) => s.setToolActivityDisplayMode,
    );
    const screenshotRetentionSeconds = useChatStore(
        (s) => s.screenshotRetentionSeconds,
    );
    const setScreenshotRetentionSeconds = useChatStore(
        (s) => s.setScreenshotRetentionSeconds,
    );
    const composerFontSize = useChatStore((s) => s.composerFontSize);
    const composerFontFamily = useChatStore((s) => s.composerFontFamily);
    const setComposerFontSize = useChatStore((s) => s.setComposerFontSize);
    const setComposerFontFamily = useChatStore((s) => s.setComposerFontFamily);
    const chatFontSize = useChatStore((s) => s.chatFontSize);
    const chatFontFamily = useChatStore((s) => s.chatFontFamily);
    const setChatFontSize = useChatStore((s) => s.setChatFontSize);
    const setChatFontFamily = useChatStore((s) => s.setChatFontFamily);
    const historyRetentionDays = useChatStore((s) => s.historyRetentionDays);
    const setHistoryRetentionDays = useChatStore(
        (s) => s.setHistoryRetentionDays,
    );
    const aiStorageScope = useChatStore((s) => s.aiStorageScope);
    const setAiStorageScope = useChatStore((s) => s.setAiStorageScope);
    const moveAiHistoryStorage = useChatStore((s) => s.moveAiHistoryStorage);
    const aiHistoryRecovery = useChatStore((s) => s.aiHistoryRecovery);
    const syncVaultScopedAiPreferences = useChatStore(
        (s) => s.syncVaultScopedAiPreferences,
    );
    const initializeChat = useChatStore((s) => s.initialize);
    const chatSessionsById = useChatStore((s) => s.sessionsById);
    const [historyMigrationPrompt, setHistoryMigrationPrompt] = useState<{
        fromScope: AIStorageScope;
        toScope: AIStorageScope;
    } | null>(null);
    const [historyMigrationStatus, setHistoryMigrationStatus] = useState<
        "idle" | "checking" | "moving" | "error"
    >("idle");
    const [historyMigrationMessage, setHistoryMigrationMessage] = useState<
        string | null
    >(null);
    // React state updates are not synchronous, so this also guards repeated
    // toggle events before the checking state can disable the control.
    const historyScopeInspectionInFlightRef = useRef(false);
    const hasLoadedMigratableAiChats = () =>
        Object.values(chatSessionsById).some(
            (session) =>
                (!vaultPath ||
                    !session.vaultPath ||
                    session.vaultPath === vaultPath) &&
                ((session.persistedMessageCount ?? session.messages.length) >
                    0 ||
                    session.parentSessionId != null),
        );
    const applySelectedStorageScope = async (scope: AIStorageScope) => {
        await setAiStorageScope(scope);
        await initializeChat({ createDefaultSession: false });
    };
    const sendShortcut = formatPrimaryShortcut("Enter", getDesktopPlatform());
    const fontKeywords = EDITOR_FONT_FAMILY_OPTIONS.flatMap((option) => [
        option.value,
        option.label,
        option.group,
    ]);

    useEffect(() => {
        if (!vaultPath) return;
        syncVaultScopedAiPreferences(vaultPath);
    }, [syncVaultScopedAiPreferences, vaultPath]);

    const showContext = sectionHasSettingsSearchMatches(
        searchQuery,
        "Context",
        [
            [
                "Inline review in editor",
                "Show AI file changes inline in editors with accept and reject controls. Available only in source mode. This preference is saved per vault.",
                "review",
                "accept",
                "reject",
            ],
        ],
    );
    const showChat = sectionHasSettingsSearchMatches(searchQuery, "Chat", [
        [
            "Store AI chats inside this vault",
            "AI chat history and pasted AI attachments will sync or be shared with this vault. Keep this off for shared or cloud-synced vaults.",
            "local",
            "device",
            "vault",
            "sync",
            "attachments",
        ],
        ["Chat font family", "Font used for messages in the chat.", ...fontKeywords],
        ["Chat font size", "Font size of messages in the chat, in pixels."],
        [
            "Tool activity display",
            "Choose how tool activity appears between assistant messages.",
            "Expanded",
            "Collapsed",
            "Hide routine activity",
        ],
        [
            "Chat history retention",
            "How long saved chat histories stay in the selected AI storage location before they are automatically deleted.",
            "Forever",
            "1 day",
            "7 days",
            "30 days",
            "90 days",
            "1 year",
        ],
    ]);
    const showComposer = sectionHasSettingsSearchMatches(
        searchQuery,
        "Composer",
        [
            [
                `Require ${sendShortcut} to send`,
                `Press ${sendShortcut} to send messages. Enter alone adds a new line, making it easier to write longer messages.`,
                sendShortcut,
                "Enter",
                "new line",
            ],
            [
                "Show context usage bar",
                "Display a thin usage strip at the bottom of the composer to track context window consumption.",
                "context window",
            ],
            [
                "Screenshot retention",
                "How long pasted screenshots stay in the AI composer draft before they are removed automatically.",
                ...SCREENSHOT_RETENTION_KEYWORDS,
            ],
            [
                "Composer font family",
                "Font used in the message input box.",
                ...fontKeywords,
            ],
            [
                "Composer font size",
                "Font size of the message input box, in pixels.",
            ],
        ],
    );

    if (!showContext && !showChat && !showComposer) {
        return <EmptyPanelSearchResult />;
    }

    return (
        <div>
            {showContext ? <SectionLabel>Context</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Context"
                label="Inline review in editor"
                description="Show AI file changes inline in editors with accept and reject controls. Available only in source mode. This preference is saved per vault."
                keywords={["review", "accept", "reject"]}
                control={
                    <Toggle
                        value={inlineReviewEnabled}
                        onChange={(value) =>
                            setSetting("inlineReviewEnabled", value)
                        }
                    />
                }
            />
            {showChat ? <SectionLabel>Chat</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Store AI chats inside this vault"
                description="AI chat history and pasted AI attachments will sync or be shared with this vault. Keep this off for shared or cloud-synced vaults."
                keywords={["local", "device", "vault", "sync", "attachments"]}
                control={
                    <Toggle
                        value={aiStorageScope === "vault"}
                        disabled={
                            historyMigrationStatus === "checking" ||
                            historyMigrationStatus === "moving"
                        }
                        onChange={(enabled) => {
                            if (historyScopeInspectionInFlightRef.current) {
                                return;
                            }
                            const next: AIStorageScope = enabled
                                ? "vault"
                                : "device";
                            const previous = aiStorageScope;
                            const hasLoadedChatsInPreviousScope =
                                hasLoadedMigratableAiChats();
                            setHistoryMigrationPrompt(null);
                            setHistoryMigrationMessage(null);
                            if (previous === next) return;
                            if (!vaultPath) {
                                void applySelectedStorageScope(next);
                                return;
                            }
                            historyScopeInspectionInFlightRef.current = true;
                            if (hasLoadedChatsInPreviousScope) {
                                setHistoryMigrationPrompt({
                                    fromScope: previous,
                                    toScope: next,
                                });
                                setHistoryMigrationStatus("idle");
                            } else {
                                setHistoryMigrationStatus("checking");
                            }
                            void aiLoadSessionHistories(vaultPath, {
                                includeMessages: false,
                                storageScope: previous,
                            })
                                .then((histories) => {
                                    const hasStoredChats = histories.some(
                                        hasMigratableHistoryContent,
                                    );
                                    setHistoryMigrationPrompt(
                                        hasStoredChats ||
                                            hasLoadedChatsInPreviousScope
                                            ? {
                                                  fromScope: previous,
                                                  toScope: next,
                                              }
                                            : null,
                                    );
                                    if (
                                        !hasStoredChats &&
                                        !hasLoadedChatsInPreviousScope
                                    ) {
                                        void applySelectedStorageScope(next);
                                    }
                                    setHistoryMigrationStatus("idle");
                                })
                                .catch((error) => {
                                    console.error(
                                        "Failed to inspect AI chat history before migration:",
                                        error,
                                    );
                                    setHistoryMigrationStatus("error");
                                })
                                .finally(() => {
                                    historyScopeInspectionInFlightRef.current =
                                        false;
                                });
                        }}
                    />
                }
            />
            {aiHistoryRecovery.status === "vault_only" ||
            aiHistoryRecovery.status === "device_only" ? (
                <div className="mb-3 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                    {aiHistoryRecovery.status === "vault_only"
                        ? "Legacy AI chats are currently using this vault. Open Chat History to confirm this location or move all chats to this device."
                        : "AI chats were recovered on this device. Open Chat History to confirm this location or move all chats into this vault."}
                </div>
            ) : null}
            {aiHistoryRecovery.status === "required" ? (
                <div className="mb-3 rounded-md border border-[var(--warning)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                    AI chat history exists in both locations. Open Chat History to choose one canonical location.
                    {aiHistoryRecovery.conflictSessionIds.length > 0
                        ? ` Conflicting chats: ${aiHistoryRecovery.conflictSessionIds.join(", ")}.`
                        : ""}
                </div>
            ) : null}
            {historyMigrationPrompt ? (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="ai-history-migration-title"
                    className="fixed inset-0 z-[10000] flex items-center justify-center p-6"
                    style={{
                        backgroundColor: "rgb(0 0 0 / 0.28)",
                        backdropFilter: "blur(6px)",
                    }}
                >
                    <div
                        className="w-full max-w-[440px] rounded-xl border p-5 text-sm"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            borderColor: "var(--border)",
                            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
                        }}
                    >
                        <div
                            className="text-[11px] font-medium uppercase tracking-[0.16em]"
                            style={{ color: "var(--accent)" }}
                        >
                            AI Chat History
                        </div>
                        <div
                            id="ai-history-migration-title"
                            className="mt-1.5 text-base font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            {historyMigrationPrompt.toScope === "vault"
                                ? "Move all AI chats into this vault?"
                                : "Move all AI chats to this device?"}
                        </div>
                        <div
                            className="mt-2 leading-relaxed"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            This moves all saved AI chats and NeverWrite-managed
                            pasted attachments. The storage setting changes only
                            after the move succeeds.
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                className="nw-dialog-btn rounded-md px-3 py-2 font-medium"
                                style={{
                                    border: "none",
                                    color: "#fff",
                                    background:
                                        "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 56%, black))",
                                    opacity:
                                        historyMigrationStatus === "moving" ||
                                        !vaultPath
                                            ? 0.5
                                            : 1,
                                }}
                                disabled={
                                    historyMigrationStatus === "moving" ||
                                    !vaultPath
                                }
                                onClick={() => {
                                    if (!vaultPath) return;
                                    setHistoryMigrationStatus("moving");
                                    void moveAiHistoryStorage(
                                        vaultPath,
                                        historyMigrationPrompt.fromScope,
                                        historyMigrationPrompt.toScope,
                                    )
                                        .then(() => {
                                            setHistoryMigrationPrompt(null);
                                            setHistoryMigrationMessage(null);
                                            setHistoryMigrationStatus("idle");
                                        })
                                        .catch((error) => {
                                            console.error(
                                                "Failed to move AI chat history:",
                                                error,
                                            );
                                            setHistoryMigrationStatus("error");
                                        });
                                }}
                            >
                                {historyMigrationStatus === "moving"
                                    ? "Moving..."
                                    : "Move all chats"}
                            </button>
                            <button
                                type="button"
                                className="nw-dialog-btn rounded-md px-3 py-2"
                                style={{
                                    color: "var(--text-secondary)",
                                    opacity:
                                        historyMigrationStatus === "moving"
                                            ? 0.5
                                            : 1,
                                }}
                                disabled={historyMigrationStatus === "moving"}
                                onClick={() => {
                                    setHistoryMigrationPrompt(null);
                                    setHistoryMigrationMessage(null);
                                    setHistoryMigrationStatus("idle");
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                        {historyMigrationStatus === "error" ? (
                            <div
                                className="mt-3 rounded-md border px-3 py-2 text-xs"
                                style={{
                                    borderColor:
                                        "color-mix(in srgb, #ef4444 40%, var(--border))",
                                    backgroundColor:
                                        "color-mix(in srgb, #ef4444 12%, var(--bg-secondary))",
                                    color: "#ef4444",
                                }}
                            >
                                AI chat history could not be checked or moved.
                            </div>
                        ) : null}
                        {historyMigrationMessage ? (
                            <div
                                className="mt-3 rounded-md border px-3 py-2 text-xs"
                                style={{
                                    borderColor:
                                        "color-mix(in srgb, #f59e0b 40%, var(--border))",
                                    backgroundColor:
                                        "color-mix(in srgb, #f59e0b 12%, var(--bg-secondary))",
                                    color: "#f59e0b",
                                }}
                            >
                                {historyMigrationMessage}
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : historyMigrationStatus === "checking" ? (
                <div className="mb-3 text-sm text-[var(--text-secondary)]">
                    Checking existing AI chats...
                </div>
            ) : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Chat font family"
                description="Font used for messages in the chat."
                keywords={fontKeywords}
                control={
                    <SelectField
                        value={chatFontFamily}
                        options={EDITOR_FONT_FAMILY_OPTIONS}
                        onChange={(value) =>
                            setChatFontFamily(value as EditorFontFamily)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Chat font size"
                description="Font size of messages in the chat, in pixels."
                control={
                    <NumberStepper
                        value={chatFontSize}
                        min={12}
                        max={28}
                        onChange={setChatFontSize}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Tool activity display"
                description="Choose how tool activity appears between assistant messages."
                keywords={["Expanded", "Collapsed", "Hide routine activity"]}
                control={
                    <SelectField
                        value={toolActivityDisplayMode}
                        options={[
                            { value: "expanded", label: "Expanded" },
                            { value: "collapsed", label: "Collapsed" },
                            {
                                value: "hidden",
                                label: "Hide routine activity",
                            },
                        ]}
                        onChange={(value) =>
                            setToolActivityDisplayMode(
                                value as ActivityDisplayMode,
                            )
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Chat"
                label="Chat history retention"
                description="How long saved chat histories stay in the selected AI storage location before they are automatically deleted."
                keywords={["Forever", "1 day", "7 days", "30 days", "90 days", "1 year"]}
                control={
                    <SelectField
                        value={historyRetentionDays}
                        options={[
                            { value: 0, label: "Forever" },
                            { value: 1, label: "1 day" },
                            { value: 7, label: "7 days" },
                            { value: 30, label: "30 days" },
                            { value: 90, label: "90 days" },
                            { value: 365, label: "1 year" },
                        ]}
                        onChange={(value) => {
                            void setHistoryRetentionDays(value);
                        }}
                    />
                }
            />
            {showComposer ? <SectionLabel>Composer</SectionLabel> : null}
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label={`Require ${sendShortcut} to send`}
                description={`Press ${sendShortcut} to send messages. Enter alone adds a new line, making it easier to write longer messages.`}
                keywords={[sendShortcut, "Enter", "new line"]}
                control={
                    <Toggle
                        value={requireCmdEnterToSend}
                        onChange={() => toggleRequireCmdEnterToSend()}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Show context usage bar"
                description="Display a thin usage strip at the bottom of the composer to track context window consumption."
                keywords={["context window"]}
                control={
                    <Toggle
                        value={contextUsageBarEnabled}
                        onChange={setContextUsageBarEnabled}
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Screenshot retention"
                description="How long pasted screenshots stay in the AI composer draft before they are removed automatically."
                keywords={SCREENSHOT_RETENTION_KEYWORDS}
                control={
                    <SelectField
                        value={screenshotRetentionSeconds}
                        options={[...SCREENSHOT_RETENTION_OPTIONS]}
                        onChange={(value) =>
                            setScreenshotRetentionSeconds(Number(value))
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Composer font family"
                description="Font used in the message input box."
                keywords={fontKeywords}
                control={
                    <SelectField
                        value={composerFontFamily}
                        options={EDITOR_FONT_FAMILY_OPTIONS}
                        onChange={(value) =>
                            setComposerFontFamily(value as EditorFontFamily)
                        }
                    />
                }
            />
            <SearchableRow
                searchQuery={searchQuery}
                section="Composer"
                label="Composer font size"
                description="Font size of the message input box, in pixels."
                control={
                    <NumberStepper
                        value={composerFontSize}
                        min={11}
                        max={20}
                        onChange={setComposerFontSize}
                    />
                }
            />
        </div>
    );
}

function AIProvidersCategorySettings({
    searchQuery,
}: {
    searchQuery: SettingsSearchQuery;
}) {
    return <AIProvidersSettings searchQuery={searchQuery} />;
}

// --- Categories ---

type Category =
    | "general"
    | "appearance"
    | "editor"
    | "ai"
    | "ai_providers"
    | "spellcheck"
    | "shortcuts"
    | "vault"
    | "developers"
    | "terminal"
    | "updates"
    | "feedback"
    | "sponsors";

function isCategory(value: string | null | undefined): value is Category {
    return CATEGORIES.some((category) => category.id === value);
}

const CATEGORIES: { id: Category; label: string; icon: React.ReactNode }[] = [
    {
        id: "general",
        label: "General",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle
                    cx="8"
                    cy="8"
                    r="2.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <path
                    d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                />
            </svg>
        ),
    },
    {
        id: "appearance",
        label: "Appearance",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle
                    cx="8"
                    cy="8"
                    r="5.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <path
                    d="M8 2.5A5.5 5.5 0 0 1 8 13.5V2.5Z"
                    fill="currentColor"
                    opacity="0.4"
                />
            </svg>
        ),
    },
    {
        id: "editor",
        label: "Editor",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M3 4h10M3 7h10M3 10h6"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                />
            </svg>
        ),
    },
    {
        id: "ai",
        label: "AI",
        icon: (
            <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z" />
                <path d="M5.5 8.5c.5 1 1.5 1.5 2.5 1.5s2-.5 2.5-1.5" />
                <path d="M6 6.5h.01M10 6.5h.01" />
            </svg>
        ),
    },
    {
        id: "ai_providers",
        label: "AI providers",
        icon: (
            <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <rect x="2.5" y="3" width="11" height="4" rx="1.5" />
                <path d="M4.5 5h2M11 5h.01" />
                <rect x="2.5" y="9" width="11" height="4" rx="1.5" />
                <path d="M4.5 11h2M11 11h.01" />
            </svg>
        ),
    },
    {
        id: "spellcheck",
        label: "Spellcheck",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M2 12h5M4.5 4v8M3 4h3M9 12l1.5-3M14 12l-1.5-3M9 12l2.5-7h.5l2.5 7M10.5 9h2.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        ),
    },
    {
        id: "shortcuts",
        label: "Shortcuts",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect
                    x="2"
                    y="4"
                    width="5"
                    height="4"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <rect
                    x="9"
                    y="4"
                    width="5"
                    height="4"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <rect
                    x="5"
                    y="10"
                    width="6"
                    height="2.5"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
            </svg>
        ),
    },
    {
        id: "vault",
        label: "Vault",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
            </svg>
        ),
    },
    {
        id: "developers",
        label: "File Tree",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M6 4 2.5 8 6 12M10 4l3.5 4-3.5 4M9 2.5 7 13.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        ),
    },
    {
        id: "terminal",
        label: "Terminal",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect
                    x="1.5"
                    y="2.5"
                    width="13"
                    height="11"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                />
                <path
                    d="M4.5 6 6.5 8 4.5 10M8 10h3.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        ),
    },
    {
        id: "updates",
        label: "Updates",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M8 2.5v7M5.5 7l2.5 2.5L10.5 7M3 12.5h10"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        ),
    },
    {
        id: "feedback",
        label: "Feedback",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M3 3.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7.5L4 14v-2H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <path
                    d="M5 6.5h6M5 9h4"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                />
            </svg>
        ),
    },
    {
        id: "sponsors",
        label: "Sponsors",
        icon: (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                    d="M8 13.25 3.15 8.72C1.35 7.04 1.15 4.42 2.7 3.05c1.15-1.02 2.9-.84 3.95.38L8 5l1.35-1.57c1.05-1.22 2.8-1.4 3.95-.38 1.55 1.37 1.35 3.99-.45 5.67L8 13.25Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        ),
    },
];

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    general: "Saving, startup, and general behavior",
    appearance: "Themes and visual preferences",
    editor: "Typography and text editing behavior",
    spellcheck: "Languages and dictionary management",
    updates: "Manual update checks and appcast configuration",
    terminal: "Font, size, and shell environment settings",
    developers: "Control which vault files appear in the file tree and pickers",
    vault: "Current vault and recent history",
    shortcuts: "Keyboard shortcuts reference",
    ai_providers: "AI runtimes, authentication, and API keys",
    ai: "AI assistant chat preferences",
    feedback: "GitHub issues, discussions, and feedback links",
    sponsors: "Ways to support NeverWrite development",
};

const STATIC_CATEGORY_SEARCH_VALUES: Record<Category, readonly SearchValue[]> = {
    general: [
        "Startup",
        "Open last vault on launch",
        "Automatically reopen the last vault when the app starts",
        "Tabs",
        "Open behavior",
        "History",
        "New tab",
    ],
    appearance: [
        "Mode",
        "System theme",
        "System",
        "Light",
        "Dark",
        "Theme",
        "Themes",
        "visual preferences",
        "Navigation",
        "File tree size",
        "Agents size",
        "Sticky folders",
        "Zoom",
        "App zoom",
        "View menu",
    ],
    editor: [
        "Typography",
        "Font size",
        "Font family",
        "Line spacing",
        "Autosave delay",
        "Formatting",
        "Line wrapping",
        "Justify text",
        "Tab size",
        "Preview",
        "Note preview on hover",
        "Hover delay",
        "Layout",
        "Text width",
    ],
    spellcheck: [
        "Languages",
        "Spellcheck",
        "Primary language",
        "Secondary language",
        "Grammar Check",
        "LanguageTool",
        "Server URL",
        "Dictionaries",
        "Spellcheck dictionaries",
        "Hunspell",
        "Dictionary Catalog",
        "Search languages",
        "Download",
        "Reload",
        "Open Folder",
    ],
    updates: [
        "Version",
        "Current version",
        "Channel",
        "Automatic updates",
        "Update status",
        "Available update",
        "Published",
        "download and install",
        "check for updates",
        "appcast",
        "release feed",
    ],
    feedback: [
        "Community",
        "Issues",
        "Discussions",
        "Create",
        "Create issue",
        "Start discussion",
        "GitHub",
        "Report bug",
        "Request feature",
        "Question",
        "Idea",
    ],
    sponsors: [
        "Support",
        "Sponsors",
        "Buy Me a Coffee",
        "GitHub Sponsors",
        "Coffee",
        "Donate",
        "Funding",
        "Support NeverWrite",
    ],
    terminal: [
        "Terminal",
        "Font family",
        "Font size",
        "Nerd Font",
        "FiraCode",
        "JetBrains Mono",
        "Claude Code",
        "Fullscreen rendering",
        "CLAUDE_CODE_NO_FLICKER",
        "Skip permissions",
        "yolo",
        "dangerously-skip-permissions",
        "Model",
        "opus",
        "sonnet",
        "haiku",
        "Continue last session",
        "resume",
        "shell",
        "monospace",
    ],
    developers: [
        "File Tree",
        "Show all vault files",
        "Show file extensions",
        "Search Files & Notes",
        "wikilink suggestions",
        "@ mentions",
    ],
    vault: [
        "Current Vault",
        "Vault path",
        "Recent Vaults",
        "Search recent vaults",
        "Clear recent vaults",
        "No recent vaults",
    ],
    shortcuts: [
        "Keyboard shortcuts",
        "Shortcuts",
        "hotkeys",
        "commands",
        "keys",
    ],
    ai_providers: [
        "AI runtimes",
        "AI providers",
        "Authentication",
        "API keys",
        "Codex",
        "Claude",
        "Kilo",
        "OpenAI",
        "Anthropic",
        "Gateway",
        "Diagnostics",
        "PATH",
        "terminal sign-in",
        "browser sign-in",
    ],
    ai: [
        "Context",
        "Inline review in editor",
        "accept",
        "reject",
        "Chat",
        "Store AI chats inside this vault",
        "local",
        "device",
        "vault",
        "sync",
        "attachments",
        "Chat font family",
        "Chat font size",
        "Tool activity display",
        "Expanded",
        "Collapsed",
        "Hide routine activity",
        "Chat history retention",
        "Composer",
        "Require command enter control enter to send",
        "Show context usage bar",
        "Screenshot retention",
        "Composer font family",
        "Composer font size",
    ],
};

interface SettingsSearchContext {
    readonly currentVaultPath: string | null;
    readonly recentVaults: readonly RecentVault[];
    readonly shortcuts: ReturnType<typeof getShortcutSettingsEntries>;
    readonly updateStatus: Pick<
        ReturnType<typeof useAppUpdateStore.getState>,
        "error" | "status"
    >;
}

function categoryHeaderMatchesSearch(
    category: Category,
    query: SettingsSearchQuery,
): boolean {
    const info = CATEGORIES.find((candidate) => candidate.id === category);

    return matchesSettingsSearch(
        query,
        info?.label,
        CATEGORY_DESCRIPTIONS[category],
    );
}

function categoryMatchesSearch(
    category: Category,
    query: SettingsSearchQuery,
    context: SettingsSearchContext,
): boolean {
    return (
        categoryHeaderMatchesSearch(category, query) ||
        matchesSettingsSearch(
            query,
            ...STATIC_CATEGORY_SEARCH_VALUES[category],
            ...getDynamicCategorySearchValues(category, context),
        )
    );
}

function getDynamicCategorySearchValues(
    category: Category,
    context: SettingsSearchContext,
): readonly SearchValue[] {
    switch (category) {
        case "appearance":
            return THEME_ORDER.flatMap((name) => [name, themes[name].label]);
        case "editor":
            return EDITOR_FONT_FAMILY_OPTIONS.flatMap((option) => [
                option.value,
                option.label,
                option.group,
            ]);
        case "spellcheck":
            return [];
        case "updates":
            return [
                context.updateStatus.status?.currentVersion,
                context.updateStatus.status?.channel,
                context.updateStatus.status?.message,
                context.updateStatus.status?.update?.version,
                context.updateStatus.status?.update?.date,
                context.updateStatus.status?.update?.body,
                context.updateStatus.error,
            ];
        case "feedback":
            return [];
        case "sponsors":
            return [];
        case "terminal":
            return [];
        case "developers":
            return [];
        case "vault":
            return [
                context.currentVaultPath,
                ...context.recentVaults.flatMap((vault) => [
                    vault.name,
                    vault.path,
                ]),
            ];
        case "shortcuts":
            return context.shortcuts.flatMap((shortcut) => [
                shortcut.category,
                shortcut.label,
                shortcut.shortcut,
            ]);
        case "ai_providers":
            return PROVIDER_CATALOG.flatMap((provider) => [
                provider.id,
                provider.name,
                provider.company,
            ]);
        case "ai":
            return EDITOR_FONT_FAMILY_OPTIONS.flatMap((option) => [
                option.value,
                option.label,
                option.group,
            ]);
        case "general":
            return [];
    }
}

// --- Main panel ---

export function SettingsPanel({
    onClose,
    standalone = false,
    initialCategory,
}: {
    onClose: () => void;
    standalone?: boolean;
    initialCategory?: Category;
}) {
    const initializeUpdates = useAppUpdateStore((state) => state.initialize);
    const updateAvailable = useAppUpdateStore(
        (state) => !!state.status?.update,
    );
    const updateSearchStatus = useAppUpdateStore((state) => state.status);
    const updateSearchError = useAppUpdateStore((state) => state.error);
    const currentVaultPath = useVaultStore((state) => state.vaultPath);
    const routeVaultPath = standalone ? readSearchParam("vault") : null;
    const resolvedVaultPath = currentVaultPath ?? routeVaultPath;
    const sectionFromUrl = standalone ? readSearchParam("section") : null;
    const resolvedInitialCategory =
        initialCategory && isCategory(initialCategory)
            ? initialCategory
            : isCategory(sectionFromUrl)
              ? sectionFromUrl
              : "general";
    const desktopPlatform = getDesktopPlatform();
    const standaloneWindow = standalone ? getCurrentWebviewWindow() : null;
    const isStandaloneNativeTitlebarOverlay =
        standalone &&
        (desktopPlatform === "windows" || desktopPlatform === "linux");
    // Standalone Settings uses the native window material (macOS vibrancy,
    // Windows 11 acrylic) on the top bar and left sidebar. The outer shell
    // stays transparent so the material shows through; the content pane
    // re-anchors to a solid bg so only the chrome is translucent.
    const useWindowMaterial =
        standalone &&
        (desktopPlatform === "macos" || desktopPlatform === "windows");
    const shellBackground = useWindowMaterial
        ? "transparent"
        : "var(--bg-primary)";
    const chromeBackground = useWindowMaterial
        ? "var(--sidebar-vibrancy-tint, var(--bg-secondary))"
        : "var(--bg-secondary)";
    const [active, setActive] = useState<Category>(resolvedInitialCategory);
    const [search, setSearch] = useState("");
    const searchQuery = createSettingsSearchQuery(search);
    const shortcutEntries = getShortcutSettingsEntries(desktopPlatform);
    const searchContext: SettingsSearchContext = {
        currentVaultPath: resolvedVaultPath,
        recentVaults: getRecentVaults(),
        shortcuts: shortcutEntries,
        updateStatus: {
            error: updateSearchError,
            status: updateSearchStatus,
        },
    };
    const filteredCategories = CATEGORIES.filter((category) =>
        categoryMatchesSearch(category.id, searchQuery, searchContext),
    );
    const activeCategory =
        filteredCategories.find((category) => category.id === active)?.id ??
        filteredCategories[0]?.id ??
        active;
    const activeInfo =
        CATEGORIES.find((category) => category.id === activeCategory) ??
        CATEGORIES[0];
    const activeSearchQuery = categoryHeaderMatchesSearch(
        activeCategory,
        searchQuery,
    )
        ? EMPTY_SEARCH_QUERY
        : searchQuery;
    const hasSearch = searchQuery.terms.length > 0;

    const handleClose = standalone
        ? () => void standaloneWindow?.close()
        : onClose;

    useEffect(() => {
        void initializeUpdates({ backgroundCheck: true });
    }, [initializeUpdates]);

    useEffect(() => {
        if (initialCategory) {
            setActive(initialCategory);
        }
    }, [initialCategory]);

    useEffect(() => {
        if (activeCategory !== active) {
            setActive(activeCategory);
        }
    }, [active, activeCategory]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                handleClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [standalone]);

    useEffect(() => {
        if (!standalone) {
            return;
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;

        void listen<{ section?: string }>(
            SETTINGS_OPEN_SECTION_EVENT,
            (event) => {
                const nextSection = event.payload?.section ?? null;
                if (isCategory(nextSection)) {
                    setActive(nextSection);
                }
            },
        ).then((cleanup) => {
            if (disposed) {
                cleanup();
                return;
            }
            unlisten = cleanup;
        });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [standalone]);

    return (
        <div
            style={{
                ...(standalone
                    ? { height: "100vh" }
                    : { position: "fixed", inset: 0, zIndex: 100 }),
                backgroundColor: shellBackground,
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* Header */}
            <WindowChrome
                showLeadingInset={standalone}
                onBackgroundMouseDown={(e) => {
                    if (
                        standalone &&
                        e.button === 0 &&
                        !(e.target as HTMLElement).closest("button")
                    ) {
                        e.preventDefault();
                        void standaloneWindow?.startDragging();
                    }
                }}
                onBackgroundDoubleClick={(e) => {
                    if (
                        !standalone ||
                        !isStandaloneNativeTitlebarOverlay ||
                        (e.target as HTMLElement).closest("button")
                    ) {
                        return;
                    }

                    if (
                        typeof standaloneWindow?.toggleMaximize !== "function"
                    ) {
                        return;
                    }

                    void standaloneWindow.toggleMaximize();
                }}
                onLeadingInsetMouseDown={(e) => {
                    if (standalone && e.button === 0) {
                        e.preventDefault();
                        void standaloneWindow?.startDragging();
                    }
                }}
                barStyle={{
                    alignItems: "center",
                    position: "relative",
                    padding: "0 20px",
                    // Standalone settings on Windows and Linux get native
                    // caption buttons via `titleBarOverlay` in the top-right
                    // 140px — reserve that space so the header content never
                    // slides under them.
                    paddingRight: isStandaloneNativeTitlebarOverlay ? 140 : 20,
                    borderBottom: "1px solid var(--border)",
                    flexShrink: 0,
                    backgroundColor: chromeBackground,
                    cursor: standalone ? "default" : undefined,
                }}
            >
                <span
                    style={{
                        position: "absolute",
                        left: "50%",
                        transform: "translateX(-50%)",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        pointerEvents: "none",
                        whiteSpace: "nowrap",
                    }}
                >
                    Settings
                </span>
                {!standalone && (
                    <button
                        onClick={handleClose}
                        title="Close settings (Esc)"
                        style={{
                            width: 24,
                            height: 24,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            borderRadius: 5,
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            fontSize: 16,
                            color: "var(--text-secondary)",
                            opacity: 0.6,
                            marginLeft: "auto",
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.opacity = "1";
                            e.currentTarget.style.backgroundColor =
                                "var(--bg-tertiary)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.opacity = "0.6";
                            e.currentTarget.style.backgroundColor =
                                "transparent";
                        }}
                    >
                        ✕
                    </button>
                )}
            </WindowChrome>

            {/* Body */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    overflow: "hidden",
                }}
            >
                {/* Sidebar */}
                <div
                    style={{
                        width: 220,
                        flexShrink: 0,
                        borderRight: "1px solid var(--border)",
                        display: "flex",
                        flexDirection: "column",
                        backgroundColor: chromeBackground,
                        overflow: "hidden",
                    }}
                >
                    {/* Search */}
                    <div style={{ padding: "10px 10px 6px" }}>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--border)",
                                borderRadius: 7,
                                padding: "5px 10px",
                            }}
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 16 16"
                                fill="none"
                                style={{ opacity: 0.4, flexShrink: 0 }}
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
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape" && search) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setSearch("");
                                    }
                                }}
                                aria-label="Search settings"
                                placeholder="Search settings…"
                                style={{
                                    flex: 1,
                                    border: "none",
                                    background: "transparent",
                                    fontSize: 12,
                                    color: "var(--text-primary)",
                                    outline: "none",
                                    fontFamily: "inherit",
                                }}
                            />
                            {search ? (
                                <button
                                    type="button"
                                    aria-label="Clear search"
                                    onClick={() => setSearch("")}
                                    style={{
                                        border: "none",
                                        background: "transparent",
                                        color: "var(--text-secondary)",
                                        cursor: "pointer",
                                        fontSize: 12,
                                        lineHeight: 1,
                                        padding: 0,
                                    }}
                                >
                                    ×
                                </button>
                            ) : null}
                        </div>
                    </div>

                    {/* Categories */}
                    <div
                        style={{
                            flex: 1,
                            overflowY: "auto",
                            padding: "4px 8px",
                        }}
                    >
                        {filteredCategories.map((cat) => {
                            const isActive = cat.id === activeCategory;
                            const showUpdateBadge =
                                cat.id === "updates" && updateAvailable;
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => setActive(cat.id)}
                                    style={{
                                        width: "100%",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                        padding: "6px 10px",
                                        borderRadius: 6,
                                        border: "none",
                                        cursor: "pointer",
                                        fontSize: 13,
                                        fontFamily: "inherit",
                                        textAlign: "left",
                                        backgroundColor: isActive
                                            ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                                            : "transparent",
                                        color: isActive
                                            ? "var(--accent)"
                                            : "var(--text-secondary)",
                                        fontWeight: isActive ? 500 : 400,
                                        marginBottom: 1,
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isActive)
                                            e.currentTarget.style.backgroundColor =
                                                "var(--bg-tertiary)";
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isActive)
                                            e.currentTarget.style.backgroundColor =
                                                "transparent";
                                    }}
                                >
                                    <span
                                        style={{
                                            opacity: isActive ? 1 : 0.6,
                                            position: "relative",
                                            display: "inline-flex",
                                        }}
                                    >
                                        {cat.icon}
                                        {showUpdateBadge ? (
                                            <span
                                                aria-hidden="true"
                                                style={{
                                                    position: "absolute",
                                                    top: -2,
                                                    right: -4,
                                                    width: 6,
                                                    height: 6,
                                                    borderRadius: "50%",
                                                    background: "var(--accent)",
                                                }}
                                            />
                                        ) : null}
                                    </span>
                                    {cat.label}
                                </button>
                            );
                        })}
                        {filteredCategories.length === 0 ? (
                            <div
                                style={{
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                    lineHeight: 1.45,
                                    padding: "8px 10px",
                                }}
                            >
                                No settings found.
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* Content */}
                <div
                    style={{
                        flex: 1,
                        overflowY: "auto",
                        padding: "0 48px 48px",
                        backgroundColor: "var(--bg-primary)",
                    }}
                >
                    <div style={{ maxWidth: 600 }}>
                        {/* Category header */}
                        <div
                            style={{
                                padding: "24px 0 12px",
                                marginBottom: 4,
                            }}
                        >
                            <h2
                                style={{
                                    fontSize: 18,
                                    fontWeight: 600,
                                    color: "var(--text-primary)",
                                    margin: 0,
                                    lineHeight: 1.2,
                                }}
                            >
                                {activeInfo.label}
                            </h2>
                            <p
                                style={{
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                    margin: "4px 0 0",
                                    fontFamily: "monospace",
                                }}
                            >
                                {CATEGORY_DESCRIPTIONS[activeCategory]}
                            </p>
                        </div>

                        {filteredCategories.length === 0 && hasSearch ? (
                            <EmptySettingsSearch search={search} />
                        ) : null}
                        {filteredCategories.length > 0 &&
                            activeCategory === "general" && (
                                <GeneralSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "appearance" && (
                                <AppearanceSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "editor" && (
                                <EditorSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "spellcheck" && (
                                <SpellcheckSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "updates" && (
                                <UpdatesSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "feedback" && (
                                <FeedbackSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "sponsors" && (
                                <SponsorsSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "terminal" && (
                                <TerminalSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "developers" && (
                                <FileTreeSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "vault" && (
                                <VaultSettings searchQuery={activeSearchQuery} />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "shortcuts" && (
                                <ShortcutsSettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "ai_providers" && (
                                <AIProvidersCategorySettings
                                    searchQuery={activeSearchQuery}
                                />
                            )}
                        {filteredCategories.length > 0 &&
                            activeCategory === "ai" && (
                                <AISettings
                                    searchQuery={activeSearchQuery}
                                    vaultPath={resolvedVaultPath}
                                />
                            )}
                    </div>
                </div>
            </div>
        </div>
    );
}
