import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    EDITOR_FONT_FAMILY_OPTIONS,
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
import { useSpellcheckStore } from "../spellcheck/store";
import { getShortcutSettingsEntries } from "../../app/shortcuts/registry";
import { formatPrimaryShortcut } from "../../app/shortcuts/format";
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
import { MarkdownContent } from "../ai/components/MarkdownContent";
import { getChatPillMetrics } from "../ai/components/chatPillMetrics";
import { AIProvidersSettings } from "./AIProvidersSettings";
import { useAppUpdateStore } from "../updates/store";
import {
    collectSensitiveUpdateState,
    listLiveWindowOperationalStates,
    type SensitiveUpdateState,
} from "../updates/sensitiveState";

// --- Primitives ---

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
            onClick={() => !disabled && onChange(!value)}
            style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                border: "none",
                cursor: disabled ? "not-allowed" : "pointer",
                backgroundColor: value ? "var(--accent)" : "var(--bg-tertiary)",
                position: "relative",
                flexShrink: 0,
                transition: "background-color 150ms",
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
                            transition: "all 100ms",
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
            if (e.key === "Escape") setOpen(false);
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
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "var(--bg-tertiary)";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.backgroundColor =
                                                "transparent";
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
    onChange,
}: {
    value: number;
    min: number;
    max: number;
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
                onClick={() => onChange(Math.max(min, value - 1))}
                style={{
                    width: 24,
                    height: 26,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
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
                        setLocal(String(value));
                        setIsEditing(false);
                        inputRef.current?.blur();
                    }
                }}
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
                onClick={() => onChange(Math.min(max, value + 1))}
                style={{
                    width: 24,
                    height: 26,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
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
                            transition: "border-color 150ms",
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

function GeneralSettings() {
    const { openLastVaultOnLaunch, tabOpenBehavior, setSetting } =
        useSettingsStore();

    return (
        <div>
            <SectionLabel>Startup</SectionLabel>
            <Row
                label="Open last vault on launch"
                description="Automatically reopen the last vault when VaultAI starts."
                control={
                    <Toggle
                        value={openLastVaultOnLaunch}
                        onChange={(v) => setSetting("openLastVaultOnLaunch", v)}
                    />
                }
            />

            <SectionLabel>Tabs</SectionLabel>
            <Row
                label="Open behavior"
                description="Choose whether opening notes and files reuses the current tab history or creates a new tab."
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

function AppearanceSettings() {
    const { mode, setMode, themeName, setThemeName } = useThemeStore();
    const { fileTreeScale, setSetting } = useSettingsStore();

    return (
        <div>
            <SectionLabel>Mode</SectionLabel>
            <Row
                label="System theme"
                description="Choose how VaultAI looks. 'System' follows your OS preference."
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

            <SectionLabel>Theme</SectionLabel>
            <ThemePicker value={themeName} onChange={setThemeName} />

            <SectionLabel>Navigation</SectionLabel>
            <Row
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
        </div>
    );
}

function EditorSettings() {
    const {
        editorFontSize,
        editorFontFamily,
        editorLineHeight,
        editorContentWidth,
        lineWrapping,
        justifyText,
        tabSize,
        setSetting,
    } = useSettingsStore();

    return (
        <div>
            <SectionLabel>Typography</SectionLabel>
            <Row
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
            <Row
                label="Font family"
                description="Font used in the editor."
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
            <Row
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

            <SectionLabel>Formatting</SectionLabel>
            <Row
                label="Line wrapping"
                description="Wrap long lines to fit the editor width."
                control={
                    <Toggle
                        value={lineWrapping}
                        onChange={(v) => setSetting("lineWrapping", v)}
                    />
                }
            />
            <Row
                label="Justify text"
                description="Distribute wrapped lines evenly across the editor width."
                control={
                    <Toggle
                        value={justifyText}
                        onChange={(v) => setSetting("justifyText", v)}
                    />
                }
            />
            <Row
                label="Tab size"
                description="Number of spaces inserted when pressing Tab."
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

            <SectionLabel>Layout</SectionLabel>
            <Row
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
        </div>
    );
}

function SpellcheckSettings() {
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
    const filteredCatalogEntries = catalogSearch
        ? downloadableCatalogEntries.filter(
              (entry) =>
                  entry.label
                      .toLowerCase()
                      .includes(catalogSearch.toLowerCase()) ||
                  entry.id.toLowerCase().includes(catalogSearch.toLowerCase()),
          )
        : downloadableCatalogEntries;
    const spellcheckPacksDirectory = spellcheckRuntimeDirectory
        ? `${spellcheckRuntimeDirectory}/packs`
        : null;

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
            <Row
                label="Spellcheck"
                description="Use the app spellcheck engine in Markdown notes and note titles."
                control={
                    <Toggle
                        value={editorSpellcheck}
                        onChange={(v) => setSetting("editorSpellcheck", v)}
                    />
                }
            />
            <Row
                label="Primary language"
                description={spellcheckPrimaryLanguageDescription}
                disabled={!editorSpellcheck}
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
            <Row
                label="Secondary language"
                description={spellcheckSecondaryLanguageDescription}
                disabled={!editorSpellcheck}
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
            <SectionLabel>Grammar Check</SectionLabel>
            <Row
                label="Grammar check"
                description="Check grammar and style using LanguageTool. Uses the spellcheck primary language."
                control={
                    <Toggle
                        value={grammarCheckEnabled}
                        onChange={(v) => setSetting("grammarCheckEnabled", v)}
                    />
                }
            />
            <Row
                label="Server URL"
                description="Leave empty to use the public LanguageTool API. For privacy, run a local server (e.g. localhost:8081)."
                disabled={!grammarCheckEnabled}
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
            {grammarCheckEnabled && !grammarCheckServerUrl && (
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
            <SectionLabel>Dictionaries</SectionLabel>
            <Row
                label="Spellcheck dictionaries"
                description="Bundled dictionaries are ready immediately. Downloadable Hunspell packs live in the app spellcheck folder and can be managed even while spellcheck is off."
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
            {downloadableCatalogEntries.length > 0 && (
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

function VaultSettings() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [recents, setRecents] = useState<RecentVault[]>(() =>
        getRecentVaults(),
    );
    const [confirmPath, setConfirmPath] = useState<string | null>(null);
    const [recentSearch, setRecentSearch] = useState("");

    const normalizedRecentSearch = recentSearch.trim().toLowerCase();
    const filteredRecents = recents.filter((vault) => {
        if (!normalizedRecentSearch) return true;
        return (
            vault.name.toLowerCase().includes(normalizedRecentSearch) ||
            vault.path.toLowerCase().includes(normalizedRecentSearch)
        );
    });

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
            <SectionLabel>Current Vault</SectionLabel>
            <Row
                label="Vault path"
                description="The folder currently open as your vault."
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

            <SectionLabel>Recent Vaults</SectionLabel>
            {recents.length === 0 ? (
                <p
                    style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        padding: "12px 0",
                    }}
                >
                    No recent vaults.
                </p>
            ) : (
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
            )}
        </div>
    );
}

function UpdatesSettings() {
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
            const next = collectSensitiveUpdateState(
                await listLiveWindowOperationalStates(),
            );
            if (!cancelled) {
                setSensitiveState(next);
            }
        };

        void refreshSensitiveState();
        const unsubscribeStorage = subscribeSafeStorage(() => {
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

    const effectiveError = error ?? status?.message ?? null;
    const updaterStateLabel = loading
        ? "Loading"
        : installing
          ? "Installing"
          : status?.update
            ? "Update available"
            : status?.enabled
              ? "Ready"
              : "Not configured";
    const lastCheckedLabel =
        lastCheckedAt == null
            ? "Never"
            : formatUpdateDate(new Date(lastCheckedAt).toISOString());
    const anyBusy = loading || checking || installing;
    const showConfirmInstall =
        confirmInstall && sensitiveState.requiresConfirmation;

    return (
        <div>
            <SectionLabel>Release feed</SectionLabel>
            <Row
                label="Current version"
                control={
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            fontVariantNumeric: "tabular-nums",
                        }}
                    >
                        {status?.currentVersion ?? "..."}
                    </span>
                }
            />
            <Row
                label="Channel"
                control={
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            textTransform: "lowercase",
                        }}
                    >
                        {status?.channel ?? "stable"}
                    </span>
                }
            />
            <Row
                label="Status"
                description={
                    !status?.enabled && !status?.endpoint
                        ? "Set VAULTAI_UPDATER_BASE_URL to enable."
                        : undefined
                }
                control={
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                        }}
                    >
                        {updaterStateLabel}
                    </span>
                }
            />
            <Row
                label="Last check"
                control={
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            fontVariantNumeric: "tabular-nums",
                        }}
                    >
                        {lastCheckedLabel}
                    </span>
                }
            />

            <div
                style={{
                    paddingTop: 12,
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                }}
            >
                <button
                    type="button"
                    disabled={anyBusy}
                    onClick={() => {
                        setConfirmInstall(false);
                        void checkNow();
                    }}
                    style={{
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        backgroundColor: "var(--bg-tertiary)",
                        color: "var(--text-primary)",
                        padding: "6px 10px",
                        fontSize: 12,
                        fontFamily: "inherit",
                        cursor: anyBusy ? "not-allowed" : "pointer",
                        opacity: anyBusy ? 0.5 : 1,
                    }}
                >
                    {checking ? "Checking..." : "Check for updates"}
                </button>
                {status?.update ? (
                    <button
                        type="button"
                        disabled={anyBusy}
                        onClick={() => {
                            if (
                                sensitiveState.requiresConfirmation &&
                                !showConfirmInstall
                            ) {
                                setConfirmInstall(true);
                                return;
                            }
                            void installAvailableUpdate().catch(() => {});
                        }}
                        style={{
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-tertiary)",
                            color: "var(--text-primary)",
                            padding: "6px 10px",
                            fontSize: 12,
                            fontFamily: "inherit",
                            cursor: anyBusy ? "not-allowed" : "pointer",
                            opacity: anyBusy ? 0.5 : 1,
                        }}
                    >
                        {installing ? "Installing..." : "Download and install"}
                    </button>
                ) : null}
            </div>

            {effectiveError ? (
                <div
                    style={{
                        marginTop: 12,
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                        fontSize: 12,
                        lineHeight: 1.5,
                    }}
                >
                    {effectiveError}
                </div>
            ) : null}

            {status?.update && showConfirmInstall ? (
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
                        <button
                            type="button"
                            disabled={installing}
                            onClick={() => {
                                void installAvailableUpdate().catch(() => {});
                            }}
                            style={{
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                padding: "6px 10px",
                                fontSize: 12,
                                fontFamily: "inherit",
                                cursor: installing ? "not-allowed" : "pointer",
                                opacity: installing ? 0.5 : 1,
                            }}
                        >
                            {installing ? "Installing..." : "Install anyway"}
                        </button>
                        <button
                            type="button"
                            disabled={installing}
                            onClick={() => setConfirmInstall(false)}
                            style={{
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                backgroundColor: "transparent",
                                color: "var(--text-secondary)",
                                padding: "6px 10px",
                                fontSize: 12,
                                fontFamily: "inherit",
                                cursor: installing ? "not-allowed" : "pointer",
                                opacity: installing ? 0.5 : 1,
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}

            {status?.update ? (
                <>
                    <SectionLabel>Available update</SectionLabel>
                    <Row
                        label="Version"
                        control={
                            <span
                                style={{
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                    fontVariantNumeric: "tabular-nums",
                                }}
                            >
                                {status.update.version}
                            </span>
                        }
                    />
                    <Row
                        label="Published"
                        control={
                            <span
                                style={{
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                }}
                            >
                                {formatUpdateDate(status.update.date)}
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
            ) : hasChecked && !effectiveError ? (
                <div
                    style={{
                        paddingTop: 16,
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        lineHeight: 1.5,
                    }}
                >
                    You're up to date.
                </div>
            ) : !hasChecked && !effectiveError ? (
                <div
                    style={{
                        paddingTop: 16,
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        lineHeight: 1.5,
                    }}
                >
                    Check manually to see if a new version is available.
                </div>
            ) : null}
        </div>
    );
}

function DevelopersSettings() {
    const {
        developerModeEnabled,
        developerTerminalEnabled,
        lineWrapping,
        fileTreeContentMode,
        fileTreeShowExtensions,
        setSetting,
    } = useSettingsStore();

    return (
        <div>
            <SectionLabel>Developer Mode</SectionLabel>
            <Row
                label="Enable Developer Mode"
                description="Show experimental developer-facing surfaces such as the integrated terminal panel."
                control={
                    <Toggle
                        value={developerModeEnabled}
                        onChange={(value) =>
                            setSetting("developerModeEnabled", value)
                        }
                    />
                }
            />
            <Row
                label="Enable Integrated Terminal"
                description="Show the bottom developer terminal panel and its related commands."
                disabled={!developerModeEnabled}
                control={
                    <Toggle
                        value={developerTerminalEnabled}
                        disabled={!developerModeEnabled}
                        onChange={(value) =>
                            setSetting("developerTerminalEnabled", value)
                        }
                    />
                }
            />

            <SectionLabel>Editor</SectionLabel>
            <Row
                label="Line wrapping"
                description="Wrap long lines to fit the editor width."
                control={
                    <Toggle
                        value={lineWrapping}
                        onChange={(value) => setSetting("lineWrapping", value)}
                    />
                }
            />

            <SectionLabel>File Tree</SectionLabel>
            <Row
                label="Show all vault files"
                description="Display every file in the vault tree, not only Markdown notes and PDFs."
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
            <Row
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
            {fileTreeContentMode === "all_files" && (
                <div
                    className="mx-4 mt-3 rounded-lg px-3 py-2 text-[12px]"
                    style={{
                        border: "1px solid var(--border)",
                        backgroundColor: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                    }}
                >
                    File-oriented search is active. Search Files & Notes, New
                    Tab, `@` mentions, and wikilink suggestions now match notes
                    by file name and path before note title, and text files can
                    also appear in `@` mentions and `[[ ]]` suggestions.
                </div>
            )}
        </div>
    );
}

function ShortcutsSettings() {
    const platform = getDesktopPlatform();
    const shortcuts = getShortcutSettingsEntries(platform);

    const grouped = shortcuts.reduce<Record<string, typeof shortcuts>>(
        (acc, s) => {
            (acc[s.category] ??= []).push(s);
            return acc;
        },
        {},
    );

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

function AISettings() {
    const inlineReviewEnabled = useSettingsStore((s) => s.inlineReviewEnabled);
    const setSetting = useSettingsStore((s) => s.setSetting);
    const autoContextEnabled = useChatStore((s) => s.autoContextEnabled);
    const toggleAutoContext = useChatStore((s) => s.toggleAutoContext);
    const requireCmdEnterToSend = useChatStore((s) => s.requireCmdEnterToSend);
    const toggleRequireCmdEnterToSend = useChatStore(
        (s) => s.toggleRequireCmdEnterToSend,
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
    const sendShortcut = formatPrimaryShortcut("Enter", getDesktopPlatform());

    return (
        <div>
            <SectionLabel>Context</SectionLabel>
            <Row
                label="Include current note"
                description="Automatically include the active note as context when sending messages."
                control={
                    <Toggle
                        value={autoContextEnabled}
                        onChange={() => toggleAutoContext()}
                    />
                }
            />
            <Row
                label="Inline review in editor"
                description="Show AI file changes inline in editors with accept and reject controls. Available only in source mode. This preference is saved per vault."
                control={
                    <Toggle
                        value={inlineReviewEnabled}
                        onChange={(value) =>
                            setSetting("inlineReviewEnabled", value)
                        }
                    />
                }
            />
            <SectionLabel>Chat</SectionLabel>
            <Row
                label="Chat font family"
                description="Font used for messages in the chat."
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
            <Row
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
            <Row
                label="Chat history retention"
                description="How long saved chat histories stay on disk before they are automatically deleted."
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
            <SectionLabel>Composer</SectionLabel>
            <Row
                label={`Require ${sendShortcut} to send`}
                description={`Press ${sendShortcut} to send messages. Enter alone adds a new line, making it easier to write longer messages.`}
                control={
                    <Toggle
                        value={requireCmdEnterToSend}
                        onChange={() => toggleRequireCmdEnterToSend()}
                    />
                }
            />
            <Row
                label="Screenshot retention"
                description="How long pasted screenshots stay in the AI composer before they are removed automatically."
                control={
                    <SelectField
                        value={screenshotRetentionSeconds}
                        options={[
                            { value: 0, label: "Forever" },
                            { value: 30, label: "30 seconds" },
                            { value: 60, label: "1 minute" },
                            { value: 300, label: "5 minutes" },
                            { value: 900, label: "15 minutes" },
                            { value: 1800, label: "30 minutes" },
                        ]}
                        onChange={(value) =>
                            setScreenshotRetentionSeconds(Number(value))
                        }
                    />
                }
            />
            <Row
                label="Composer font family"
                description="Font used in the message input box."
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
            <Row
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

function AIProvidersCategorySettings() {
    return <AIProvidersSettings />;
}

// --- Categories ---

type Category =
    | "general"
    | "appearance"
    | "editor"
    | "spellcheck"
    | "updates"
    | "developers"
    | "vault"
    | "shortcuts"
    | "ai_providers"
    | "ai";

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
        id: "developers",
        label: "Developers",
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
];

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    general: "Saving, startup, and general behavior",
    appearance: "Themes and visual preferences",
    editor: "Typography and text editing behavior",
    spellcheck: "Languages and dictionary management",
    updates: "Manual update checks and appcast configuration",
    developers: "Advanced developer-facing file tree options",
    vault: "Current vault and recent history",
    shortcuts: "Keyboard shortcuts reference",
    ai_providers: "AI runtimes, authentication, and API keys",
    ai: "AI assistant chat preferences",
};

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
    const sectionFromUrl = standalone ? readSearchParam("section") : null;
    const resolvedInitialCategory =
        initialCategory && isCategory(initialCategory)
            ? initialCategory
            : isCategory(sectionFromUrl)
              ? sectionFromUrl
              : "general";
    const [active, setActive] = useState<Category>(resolvedInitialCategory);
    const [search, setSearch] = useState("");
    const activeInfo = CATEGORIES.find((c) => c.id === active)!;

    const handleClose = standalone
        ? () => void getCurrentWebviewWindow().close()
        : onClose;

    useEffect(() => {
        void initializeUpdates({ backgroundCheck: true });
    }, [initializeUpdates]);

    useEffect(() => {
        if (initialCategory && initialCategory !== active) {
            setActive(initialCategory);
        }
    }, [active, initialCategory]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") handleClose();
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
                backgroundColor: "var(--bg-primary)",
                display: "flex",
                flexDirection: "column",
            }}
        >
            {/* Header */}
            <WindowChrome
                showLeadingInset={standalone}
                showWindowControls={standalone}
                windowControlScope={standalone ? "webview" : "window"}
                onBackgroundMouseDown={(e) => {
                    if (
                        standalone &&
                        e.button === 0 &&
                        !(e.target as HTMLElement).closest("button")
                    ) {
                        e.preventDefault();
                        void getCurrentWindow().startDragging();
                    }
                }}
                onBackgroundDoubleClick={(e) => {
                    if (
                        !standalone ||
                        getDesktopPlatform() !== "windows" ||
                        (e.target as HTMLElement).closest("button")
                    ) {
                        return;
                    }

                    if (
                        typeof getCurrentWindow().toggleMaximize !== "function"
                    ) {
                        return;
                    }

                    void getCurrentWindow().toggleMaximize();
                }}
                onLeadingInsetMouseDown={(e) => {
                    if (standalone && e.button === 0) {
                        e.preventDefault();
                        void getCurrentWindow().startDragging();
                    }
                }}
                barStyle={{
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0 20px",
                    borderBottom: "1px solid var(--border)",
                    flexShrink: 0,
                    backgroundColor: "var(--bg-secondary)",
                    cursor: standalone ? "default" : undefined,
                }}
            >
                <span
                    style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-primary)",
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
                        backgroundColor: "var(--bg-secondary)",
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
                        {CATEGORIES.filter(
                            (c) =>
                                !search ||
                                c.label
                                    .toLowerCase()
                                    .includes(search.toLowerCase()),
                        ).map((cat) => {
                            const isActive = cat.id === active;
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
                    </div>
                </div>

                {/* Content */}
                <div
                    style={{
                        flex: 1,
                        overflowY: "auto",
                        padding: "0 48px 48px",
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
                                {CATEGORY_DESCRIPTIONS[active]}
                            </p>
                        </div>

                        {active === "general" && <GeneralSettings />}
                        {active === "appearance" && <AppearanceSettings />}
                        {active === "editor" && <EditorSettings />}
                        {active === "spellcheck" && <SpellcheckSettings />}
                        {active === "updates" && <UpdatesSettings />}
                        {active === "developers" && <DevelopersSettings />}
                        {active === "vault" && <VaultSettings />}
                        {active === "shortcuts" && <ShortcutsSettings />}
                        {active === "ai_providers" && (
                            <AIProvidersCategorySettings />
                        )}
                        {active === "ai" && <AISettings />}
                    </div>
                </div>
            </div>
        </div>
    );
}
