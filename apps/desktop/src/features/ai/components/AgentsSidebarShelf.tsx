import { useEffect, useMemo, useState, type ReactNode } from "react";

interface ShelfGroup {
    root: { sessionId: string };
    sessionIds: readonly string[];
}

interface AgentsSidebarShelfProps<T extends ShelfGroup> {
    title: string;
    groups: readonly T[];
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    focusedSessionId?: string | null;
    initialLimit?: number | null;
    renderGroup: (group: T) => ReactNode;
}

export function AgentsSidebarShelf<T extends ShelfGroup>({
    title,
    groups,
    expanded,
    onExpandedChange,
    focusedSessionId = null,
    initialLimit = null,
    renderGroup,
}: AgentsSidebarShelfProps<T>) {
    const [visibleLimit, setVisibleLimit] = useState(initialLimit);
    useEffect(() => setVisibleLimit(initialLimit), [groups.length, initialLimit]);
    const focusedGroup = focusedSessionId
        ? groups.find((group) => group.sessionIds.includes(focusedSessionId))
        : null;
    const visibleGroups = useMemo(() => {
        if (!expanded) return focusedGroup ? [focusedGroup] : [];
        const base =
            visibleLimit === null ? [...groups] : groups.slice(0, visibleLimit);
        if (
            focusedGroup &&
            !base.some(
                (group) => group.root.sessionId === focusedGroup.root.sessionId,
            )
        ) {
            base.push(focusedGroup);
        }
        return base;
    }, [expanded, focusedGroup, groups, visibleLimit]);
    if (groups.length === 0) return null;
    const hiddenCount = Math.max(0, groups.length - (visibleLimit ?? groups.length));

    return (
        <section className="mt-3" data-agent-shelf={title.toLowerCase()}>
            <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-medium uppercase tracking-[0.06em] transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                style={{ color: "var(--text-secondary)", fontSize: 10, opacity: 0.75 }}
                aria-expanded={expanded}
                onClick={() => onExpandedChange(!expanded)}
            >
                <svg
                    width="9"
                    height="9"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ transform: expanded ? "none" : "rotate(-90deg)" }}
                >
                    <path d="m4 6 4 4 4-4" />
                </svg>
                <span>{title}</span>
                <span style={{ opacity: 0.75 }}>{groups.length}</span>
            </button>
            {visibleGroups.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                    {visibleGroups.map((group) => (
                        <div key={group.root.sessionId}>{renderGroup(group)}</div>
                    ))}
                    {expanded && hiddenCount > 0 ? (
                        <button
                            type="button"
                            className="rounded px-3 py-1 text-left"
                            style={{ color: "var(--text-secondary)", fontSize: 10.5 }}
                            onClick={() => setVisibleLimit(null)}
                        >
                            Show {hiddenCount} more
                        </button>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
