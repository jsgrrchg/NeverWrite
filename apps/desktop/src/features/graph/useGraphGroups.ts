import { useEffect, useMemo, useState } from "react";
import { useVaultStore } from "../../app/store/vaultStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { parseQuery } from "../search/queryParser";
import { toAdvancedSearchParams } from "../search/queryToParams";
import { useGraphSettingsStore, type GraphGroup } from "./graphSettingsStore";
import {
    graphPerfCount,
    graphPerfMeasure,
    graphPerfMeasureCompute,
} from "./graphPerf";

/**
 * Resolves group membership for graph nodes.
 * For each group with a non-empty query, calls advanced_search to get matching IDs.
 * Returns a Map<noteId, hexColor> where the first matching group wins (priority order).
 */
export function useGraphGroups(): Map<string, string> {
    const groups = useGraphSettingsStore((s) => s.groups);
    const resolverRevision = useVaultStore((s) => s.resolverRevision);
    const [colorMap, setColorMap] = useState<Map<string, string>>(new Map());
    const emptyColorMap = useMemo(() => new Map<string, string>(), []);
    const activeGroups = useMemo(
        () => groups.filter((group) => group.query.trim()),
        [groups],
    );

    // Serialize groups to a stable key to avoid unnecessary re-evaluations
    const groupsKey = groups
        .map((g) => `${g.id}:${g.query}:${g.color}`)
        .join("|");

    useEffect(() => {
        if (activeGroups.length === 0) {
            queueMicrotask(() => {
                setColorMap((current) =>
                    current.size === 0 ? current : new Map(),
                );
            });
            return;
        }

        let cancelled = false;

        const resolve = async () => {
            const startMs = performance.now();
            try {
                const results = await Promise.all(
                    activeGroups.map((g) => resolveGroup(g)),
                );
                if (cancelled) return;

                const map = graphPerfMeasureCompute(
                    "graph.groups.colorMap.build",
                    () => {
                        const nextMap = new Map<string, string>();
                        for (let i = 0; i < activeGroups.length; i++) {
                            const color = activeGroups[i].color;
                            for (const id of results[i]) {
                                if (!nextMap.has(id)) {
                                    nextMap.set(id, color);
                                }
                            }
                        }
                        return nextMap;
                    },
                    (value) => ({
                        groupCount: activeGroups.length,
                        matchedNodeCount: value.size,
                    }),
                );

                setColorMap(map);
                graphPerfMeasure("graph.groups.resolve.duration", startMs, {
                    groupCount: activeGroups.length,
                    matchedNodeCount: map.size,
                });
                graphPerfCount("graph.groups.resolve.completed", {
                    groupCount: activeGroups.length,
                    matchedNodeCount: map.size,
                });
            } catch (error) {
                if (cancelled) return;
                graphPerfCount("graph.groups.resolve.error", {
                    groupCount: activeGroups.length,
                    message:
                        error instanceof Error ? error.message : String(error),
                });
                console.error("Error resolving graph groups:", error);
            }
        };

        void resolve();
        return () => {
            cancelled = true;
        };
    }, [activeGroups, groupsKey, resolverRevision]);

    return activeGroups.length === 0 ? emptyColorMap : colorMap;
}

async function resolveGroup(group: GraphGroup): Promise<string[]> {
    const parsed = parseQuery(group.query.trim());
    const params = toAdvancedSearchParams(parsed);
    const startMs = performance.now();
    const results = await vaultInvoke<{ id: string }[]>("advanced_search", {
        params,
    });
    graphPerfMeasure("graph.groups.resolve.group.duration", startMs, {
        groupId: group.id,
        queryLength: group.query.trim().length,
        resultCount: results.length,
    });
    return results.map((r) => r.id);
}
