import type { ReactNode } from "react";

interface AgentsSidebarSectionProps {
    title: string;
    count: number;
    showHeader?: boolean;
    showWhenEmpty?: boolean;
    isDropTarget?: boolean;
    dropTarget?: "all";
    children: ReactNode;
    headerMetrics: {
        fontSize: number;
        paddingX: number;
        paddingTop: number;
        paddingBottom: number;
    };
}

// Sections mirror the compact grouping used by Comando: the count belongs to
// the label and the extra vertical space separates session groups, not rows.

export function AgentsSidebarSection({
    title,
    count,
    showHeader = true,
    showWhenEmpty = false,
    isDropTarget = false,
    dropTarget,
    children,
    headerMetrics,
}: AgentsSidebarSectionProps) {
    if (count === 0 && !showWhenEmpty) return null;
    return (
        <section
            className="mt-3 flex flex-col rounded first:mt-0"
            data-chat-unfiled-drop-zone={dropTarget === "all" || undefined}
            style={{
                backgroundColor: isDropTarget
                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                    : "transparent",
                outline: isDropTarget
                    ? "1px solid color-mix(in srgb, var(--accent) 55%, transparent)"
                    : "1px solid transparent",
            }}
        >
            {showHeader ? (
                <div
                    className="flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.09em]"
                    style={{
                        color: "var(--text-secondary)",
                        opacity: 0.8,
                        fontSize: headerMetrics.fontSize,
                        padding: `${headerMetrics.paddingTop}px ${headerMetrics.paddingX}px ${headerMetrics.paddingBottom}px`,
                    }}
                >
                    <span>{title}</span>
                    <span style={{ opacity: 0.7 }}>{count}</span>
                </div>
            ) : null}
            <div className="flex flex-col gap-0.5">{children}</div>
        </section>
    );
}
