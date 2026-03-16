import { useSettingsStore } from "../../app/store/settingsStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useEditorStore } from "../../app/store/editorStore";

export type SidebarView = "files" | "search" | "tags" | "maps";

interface ActivityBarProps {
    active: SidebarView;
    onChange: (view: SidebarView) => void;
    onOpenSettings: () => void;
}

const items: { id: SidebarView; title: string; icon: React.ReactNode }[] = [
    {
        id: "files",
        title: "Explorer",
        icon: (
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M4 4h6l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
            </svg>
        ),
    },
    {
        id: "search",
        title: "Search",
        icon: (
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
            </svg>
        ),
    },
    {
        id: "tags",
        title: "Tags",
        icon: (
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
            </svg>
        ),
    },
    {
        id: "maps",
        title: "Concept Maps",
        icon: (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <circle
                    cx="5"
                    cy="10"
                    r="2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
                <circle
                    cx="15"
                    cy="5"
                    r="2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
                <circle
                    cx="15"
                    cy="15"
                    r="2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                />
                <path
                    d="M7.5 10L12.5 5.5M7.5 10L12.5 14.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                />
            </svg>
        ),
    },
];

export function ActivityBar({
    active,
    onChange,
    onOpenSettings,
}: ActivityBarProps) {
    const openGraph = useEditorStore((s) => s.openGraph);
    const livePreviewEnabled = useSettingsStore((s) => s.livePreviewEnabled);
    const lineWrapping = useSettingsStore((s) => s.lineWrapping);
    const developerModeEnabled = useSettingsStore(
        (s) => s.developerModeEnabled,
    );
    const developerTerminalEnabled = useSettingsStore(
        (s) => s.developerTerminalEnabled,
    );
    const setSetting = useSettingsStore((s) => s.setSetting);
    const bottomPanelCollapsed = useLayoutStore((s) => s.bottomPanelCollapsed);
    const bottomPanelView = useLayoutStore((s) => s.bottomPanelView);
    const toggleBottomPanel = useLayoutStore((s) => s.toggleBottomPanel);
    const activateBottomView = useLayoutStore((s) => s.activateBottomView);
    const baseButtonStyle = {
        width: 32,
        height: 32,
        borderRadius: 10,
        border: "1px solid transparent",
        transition:
            "background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease",
    } as const;
    const terminalButtonVisible =
        developerModeEnabled && developerTerminalEnabled;
    const terminalPanelActive =
        terminalButtonVisible &&
        !bottomPanelCollapsed &&
        bottomPanelView === "terminal";

    const handleToggleTerminalPanel = () => {
        if (!terminalButtonVisible) return;
        if (!terminalPanelActive) {
            activateBottomView("terminal");
            return;
        }
        toggleBottomPanel();
    };

    return (
        <div
            className="flex h-full flex-shrink-0 flex-col items-center px-1 py-2"
            style={{
                width: 40,
                background:
                    "linear-gradient(180deg, color-mix(in srgb, var(--bg-tertiary) 94%, white 6%), var(--bg-tertiary))",
                borderRight: "1px solid var(--border)",
            }}
        >
            {/* Top items */}
            <div
                className="flex flex-col items-center gap-1 rounded-xl px-0.5 py-1"
                style={{
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-primary) 40%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                }}
            >
                {items.map((item) => {
                    const isActive = active === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onChange(item.id)}
                            title={item.title}
                            className="flex items-center justify-center rounded"
                            style={{
                                ...baseButtonStyle,
                                color: isActive
                                    ? "var(--text-primary)"
                                    : "var(--text-secondary)",
                                backgroundColor: isActive
                                    ? "color-mix(in srgb, var(--bg-primary) 88%, var(--accent) 12%)"
                                    : "transparent",
                                borderColor: isActive
                                    ? "color-mix(in srgb, var(--accent) 18%, var(--border))"
                                    : "transparent",
                                boxShadow: isActive
                                    ? "0 1px 2px rgb(0 0 0 / 0.08)"
                                    : "none",
                                opacity: isActive ? 1 : 0.7,
                            }}
                            onMouseEnter={(e) => {
                                if (isActive) return;
                                e.currentTarget.style.backgroundColor =
                                    "color-mix(in srgb, var(--bg-primary) 72%, transparent)";
                                e.currentTarget.style.borderColor =
                                    "color-mix(in srgb, var(--border) 88%, transparent)";
                                e.currentTarget.style.color =
                                    "var(--text-primary)";
                            }}
                            onMouseLeave={(e) => {
                                if (isActive) return;
                                e.currentTarget.style.backgroundColor =
                                    "transparent";
                                e.currentTarget.style.borderColor =
                                    "transparent";
                                e.currentTarget.style.color =
                                    "var(--text-secondary)";
                            }}
                        >
                            {item.icon}
                        </button>
                    );
                })}
            </div>

            {/* Graph view button */}
            <button
                onClick={openGraph}
                title="Graph View"
                className="flex items-center justify-center rounded"
                style={{
                    ...baseButtonStyle,
                    marginTop: 8,
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    opacity: 0.7,
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--bg-primary) 72%, transparent)";
                    e.currentTarget.style.borderColor =
                        "color-mix(in srgb, var(--border) 88%, transparent)";
                    e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.color = "var(--text-secondary)";
                }}
            >
                <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="12" cy="12" r="2.5" />
                    <ellipse cx="12" cy="12" rx="9" ry="3.5" />
                    <ellipse
                        cx="12"
                        cy="12"
                        rx="9"
                        ry="3.5"
                        transform="rotate(60 12 12)"
                    />
                    <ellipse
                        cx="12"
                        cy="12"
                        rx="9"
                        ry="3.5"
                        transform="rotate(120 12 12)"
                    />
                </svg>
            </button>

            <div className="flex-1" />

            {/* Live preview toggle */}
            <button
                onClick={() =>
                    setSetting("livePreviewEnabled", !livePreviewEnabled)
                }
                title={
                    livePreviewEnabled
                        ? "Disable Live Preview (⌘E)"
                        : "Enable Live Preview (⌘E)"
                }
                className="flex items-center justify-center rounded"
                style={{
                    ...baseButtonStyle,
                    marginTop: "auto",
                    marginBottom: 6,
                    color: livePreviewEnabled
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                    backgroundColor: livePreviewEnabled
                        ? "color-mix(in srgb, var(--bg-primary) 88%, var(--accent) 12%)"
                        : "transparent",
                    borderColor: livePreviewEnabled
                        ? "color-mix(in srgb, var(--accent) 18%, var(--border))"
                        : "transparent",
                    boxShadow: livePreviewEnabled
                        ? "0 1px 2px rgb(0 0 0 / 0.08)"
                        : "none",
                    opacity: livePreviewEnabled ? 1 : 0.7,
                }}
                onMouseEnter={(e) => {
                    if (livePreviewEnabled) return;
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--bg-primary) 72%, transparent)";
                    e.currentTarget.style.borderColor =
                        "color-mix(in srgb, var(--border) 88%, transparent)";
                    e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                    if (livePreviewEnabled) return;
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.color = "var(--text-secondary)";
                }}
            >
                {livePreviewEnabled ? (
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                    </svg>
                ) : (
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                )}
            </button>

            <button
                onClick={() => setSetting("lineWrapping", !lineWrapping)}
                title={
                    lineWrapping
                        ? "Disable Line Wrapping"
                        : "Enable Line Wrapping"
                }
                className="flex items-center justify-center rounded"
                style={{
                    ...baseButtonStyle,
                    marginBottom: 6,
                    color: lineWrapping
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                    backgroundColor: lineWrapping
                        ? "color-mix(in srgb, var(--bg-primary) 88%, var(--accent) 12%)"
                        : "transparent",
                    borderColor: lineWrapping
                        ? "color-mix(in srgb, var(--accent) 18%, var(--border))"
                        : "transparent",
                    boxShadow: lineWrapping
                        ? "0 1px 2px rgb(0 0 0 / 0.08)"
                        : "none",
                    opacity: lineWrapping ? 1 : 0.7,
                }}
                onMouseEnter={(e) => {
                    if (lineWrapping) return;
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--bg-primary) 72%, transparent)";
                    e.currentTarget.style.borderColor =
                        "color-mix(in srgb, var(--border) 88%, transparent)";
                    e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                    if (lineWrapping) return;
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.color = "var(--text-secondary)";
                }}
            >
                {lineWrapping ? (
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M4 6h16" />
                        <path d="M4 12h10a3 3 0 1 1 0 6H9" />
                        <path d="m9 15-3 3 3 3" />
                    </svg>
                ) : (
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M4 6h16" />
                        <path d="M4 12h10a3 3 0 1 1 0 6H9" />
                        <path d="m9 15-3 3 3 3" />
                        <line x1="5" y1="5" x2="19" y2="19" />
                    </svg>
                )}
            </button>

            {terminalButtonVisible ? (
                <button
                    onClick={handleToggleTerminalPanel}
                    title={
                        terminalPanelActive
                            ? "Hide Integrated Terminal"
                            : "Show Integrated Terminal"
                    }
                    className="flex items-center justify-center rounded"
                    style={{
                        ...baseButtonStyle,
                        marginBottom: 6,
                        color: terminalPanelActive
                            ? "var(--text-primary)"
                            : "var(--text-secondary)",
                        backgroundColor: terminalPanelActive
                            ? "color-mix(in srgb, var(--bg-primary) 88%, var(--accent) 12%)"
                            : "transparent",
                        borderColor: terminalPanelActive
                            ? "color-mix(in srgb, var(--accent) 18%, var(--border))"
                            : "transparent",
                        boxShadow: terminalPanelActive
                            ? "0 1px 2px rgb(0 0 0 / 0.08)"
                            : "none",
                        opacity: terminalPanelActive ? 1 : 0.7,
                    }}
                    onMouseEnter={(e) => {
                        if (terminalPanelActive) return;
                        e.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, var(--bg-primary) 72%, transparent)";
                        e.currentTarget.style.borderColor =
                            "color-mix(in srgb, var(--border) 88%, transparent)";
                        e.currentTarget.style.color = "var(--text-primary)";
                    }}
                    onMouseLeave={(e) => {
                        if (terminalPanelActive) return;
                        e.currentTarget.style.backgroundColor = "transparent";
                        e.currentTarget.style.borderColor = "transparent";
                        e.currentTarget.style.color = "var(--text-secondary)";
                    }}
                >
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5Z" />
                        <path d="m8 9 3 3-3 3" />
                        <path d="M13.5 15H16" />
                    </svg>
                </button>
            ) : null}

            {/* Settings gear at bottom */}
            <button
                onClick={onOpenSettings}
                title="Settings (⌘,)"
                className="flex items-center justify-center rounded"
                style={{
                    ...baseButtonStyle,
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    opacity: 0.7,
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--bg-primary) 72%, transparent)";
                    e.currentTarget.style.borderColor =
                        "color-mix(in srgb, var(--border) 88%, transparent)";
                    e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.color = "var(--text-secondary)";
                }}
            >
                <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
            </button>
        </div>
    );
}
