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
    return (
        <div
            className="flex flex-col items-center py-1 flex-shrink-0"
            style={{
                width: 44,
                backgroundColor: "var(--bg-tertiary)",
                borderRight: "1px solid var(--border)",
            }}
        >
            {/* Top items */}
            <div className="flex flex-col items-center flex-1">
                {items.map((item) => {
                    const isActive = active === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onChange(item.id)}
                            title={item.title}
                            className="flex items-center justify-center rounded"
                            style={{
                                width: 36,
                                height: 36,
                                marginBottom: 2,
                                color: isActive
                                    ? "var(--text-primary)"
                                    : "var(--text-secondary)",
                                backgroundColor: isActive
                                    ? "var(--bg-secondary)"
                                    : "transparent",
                                opacity: isActive ? 1 : 0.6,
                            }}
                        >
                            {item.icon}
                        </button>
                    );
                })}
            </div>

            {/* Settings gear at bottom */}
            <button
                onClick={onOpenSettings}
                title="Settings (⌘,)"
                className="flex items-center justify-center rounded"
                style={{
                    width: 36,
                    height: 36,
                    marginBottom: 1,
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    opacity: 0.5,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
            >
                <svg
                    width="16"
                    height="16"
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
