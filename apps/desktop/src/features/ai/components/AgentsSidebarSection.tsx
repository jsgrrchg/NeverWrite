import type { ReactNode } from "react";

interface AgentsSidebarSectionProps {
    title: string;
    count: number;
    showHeader?: boolean;
    children: ReactNode;
}

// Thin section wrapper used to group the Pinned/Open/All buckets inside the
// Agents sidebar list. The header label renders with a subtle count suffix
// and matches the uppercase tracking used by the other sidebar panels.

export function AgentsSidebarSection({
    title,
    count,
    showHeader = true,
    children,
}: AgentsSidebarSectionProps) {
    if (count === 0) return null;
    return (
        <div className="flex flex-col">
            {showHeader ? (
                <div
                    className="flex items-center justify-between px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.1em]"
                    style={{ color: "var(--text-secondary)", opacity: 0.8 }}
                >
                    <span>{title}</span>
                    <span>{count}</span>
                </div>
            ) : null}
            <div className="flex flex-col">{children}</div>
        </div>
    );
}
