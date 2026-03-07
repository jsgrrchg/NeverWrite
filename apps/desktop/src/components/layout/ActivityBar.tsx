export type SidebarView = "files" | "search" | "ai";

interface ActivityBarProps {
    active: SidebarView;
    onChange: (view: SidebarView) => void;
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
        id: "ai",
        title: "Chat AI",
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
                <path d="M12 3a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9Z" />
                <path d="M8 12h.01M12 12h.01M16 12h.01" />
            </svg>
        ),
    },
];

export function ActivityBar({ active, onChange }: ActivityBarProps) {
    return (
        <div
            className="flex flex-col items-center py-1 flex-shrink-0"
            style={{
                width: 44,
                backgroundColor: "var(--bg-tertiary)",
                borderRight: "1px solid var(--border)",
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
    );
}
