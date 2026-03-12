import { useSettingsStore } from "../../app/store/settingsStore";

export type SidebarView = "files" | "search" | "tags";

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
];

export function ActivityBar({
    active,
    onChange,
    onOpenSettings,
}: ActivityBarProps) {
    const livePreviewEnabled = useSettingsStore((s) => s.livePreviewEnabled);
    const setSetting = useSettingsStore((s) => s.setSetting);
    const baseButtonStyle = {
        width: 32,
        height: 32,
        borderRadius: 10,
        border: "1px solid transparent",
        transition:
            "background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease",
    } as const;

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

            <div className="flex-1" />

            {/* Live preview toggle */}
            <button
                onClick={() => setSetting("livePreviewEnabled", !livePreviewEnabled)}
                title={livePreviewEnabled ? "Disable Live Preview (⌘E)" : "Enable Live Preview (⌘E)"}
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
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                    </svg>
                ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                )}
            </button>

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
