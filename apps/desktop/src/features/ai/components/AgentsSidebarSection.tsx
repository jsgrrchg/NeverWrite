import type { ReactNode } from "react";

interface AgentsSidebarSectionProps {
    title: string;
    count: number;
    showHeader?: boolean;
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
    children,
    headerMetrics,
}: AgentsSidebarSectionProps) {
    if (count === 0) return null;
    return (
        <section className="mt-3 flex flex-col first:mt-0">
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
