import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    perfCount,
    perfMeasure,
    perfNow,
} from "../../app/utils/perfInstrumentation";
import { vaultInvoke } from "../../app/utils/vaultInvoke";

type ResolvedWikilinkDto = {
    target: string;
    resolved_note_id: string | null;
    resolved_title: string | null;
};

type ResolvedNoteMatch = {
    id: string;
    title: string | null;
};

type CachedResolution = {
    noteId: string | null;
    title: string | null;
};

export type WikilinkResolutionState = "valid" | "broken" | "pending";

const resolutionCache = new Map<string, CachedResolution>();
const pendingCacheKeys = new Set<string>();

let cachedVaultPath: string | null = null;
let cachedResolverRevision: number | null = null;

function getActiveNoteId() {
    const activeTabId = useEditorStore.getState().activeTabId;
    return (
        useEditorStore.getState().tabs.find((tab) => tab.id === activeTabId)
            ?.noteId ?? null
    );
}

function ensureFreshResolverCache() {
    const { vaultPath, resolverRevision } = useVaultStore.getState();
    if (
        cachedVaultPath === vaultPath &&
        cachedResolverRevision === resolverRevision
    ) {
        return { vaultPath, resolverRevision };
    }

    resolutionCache.clear();
    pendingCacheKeys.clear();
    cachedVaultPath = vaultPath;
    cachedResolverRevision = resolverRevision;
    perfCount("editor.wikilinkResolver.cache.reset");
    return { vaultPath, resolverRevision };
}

function makeCacheKey(
    noteId: string | null,
    target: string,
    resolverRevision: number,
) {
    return `${resolverRevision}\u0000${noteId ?? ""}\u0000${target}`;
}

function scheduleBatchResolution(
    noteId: string | null,
    targets: readonly string[],
    onResolved?: () => void,
) {
    const { vaultPath, resolverRevision } = ensureFreshResolverCache();
    const uniqueTargets = [...new Set(targets.filter(Boolean))];
    if (!vaultPath || !noteId || uniqueTargets.length === 0) return;

    const missingTargets: string[] = [];
    for (const target of uniqueTargets) {
        const cacheKey = makeCacheKey(noteId, target, resolverRevision);
        if (resolutionCache.has(cacheKey) || pendingCacheKeys.has(cacheKey)) {
            continue;
        }
        pendingCacheKeys.add(cacheKey);
        missingTargets.push(target);
    }

    if (missingTargets.length === 0) return;

    const startMs = perfNow();
    perfCount("editor.wikilinkResolver.backend.batch.lookup");

    void vaultInvoke<ResolvedWikilinkDto[]>("resolve_wikilinks_batch", {
        noteId,
        targets: missingTargets,
    })
        .then((results) => {
            const activeState = ensureFreshResolverCache();
            if (
                activeState.vaultPath !== vaultPath ||
                activeState.resolverRevision !== resolverRevision
            ) {
                return;
            }

            const resolvedByTarget = new Map(
                results.map((result) => [result.target, result]),
            );

            let anyNewResult = false;
            for (const target of missingTargets) {
                const cacheKey = makeCacheKey(noteId, target, resolverRevision);
                const wasPending = pendingCacheKeys.delete(cacheKey);

                const resolved = resolvedByTarget.get(target);
                resolutionCache.set(cacheKey, {
                    noteId: resolved?.resolved_note_id ?? null,
                    title: resolved?.resolved_title ?? null,
                });

                if (wasPending) anyNewResult = true;
            }

            perfMeasure(
                "editor.wikilinkResolver.backend.batch.duration",
                startMs,
                {
                    targetCount: missingTargets.length,
                    resolvedCount: results.filter(
                        (item) => item.resolved_note_id,
                    ).length,
                },
            );

            // Only trigger refresh if we actually resolved new targets
            if (anyNewResult) {
                onResolved?.();
            }
        })
        .catch((error) => {
            for (const target of missingTargets) {
                pendingCacheKeys.delete(
                    makeCacheKey(noteId, target, resolverRevision),
                );
            }
            console.error("Error resolving wikilinks batch:", error);
        });
}

export function invalidateWikilinkCaches(reason = "manual") {
    resolutionCache.clear();
    pendingCacheKeys.clear();
    cachedVaultPath = null;
    cachedResolverRevision = null;
    perfCount(`editor.wikilinkResolver.invalidate.${reason}`);
}

export function normalizeWikilinkTarget(target: string): string {
    const trimmed = target.trim();
    const withoutSubpath = trimmed.split(/[#^]/, 1)[0]?.trim() ?? "";
    return withoutSubpath
        .replace(/\.md$/i, "")
        .replace(/['']/g, "'")
        .replace(/[""]/g, '"')
        .replace(/…/g, "...")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

export function getWikilinkVariants(target: string): string[] {
    const normalized = normalizeWikilinkTarget(target);
    if (!normalized) return [];
    const trimmed = normalized.replace(/[\s.,!?:;]+$/g, "");
    return trimmed && trimmed !== normalized
        ? [normalized, trimmed]
        : [normalized];
}

export function resolveWikilinksBatch(
    noteId: string | null,
    targets: readonly string[],
    onResolved?: () => void,
): ReadonlyMap<string, WikilinkResolutionState> {
    const { resolverRevision } = ensureFreshResolverCache();
    const uniqueTargets = [...new Set(targets.filter(Boolean))];
    const results = new Map<string, WikilinkResolutionState>();

    for (const target of uniqueTargets) {
        const cached = resolutionCache.get(
            makeCacheKey(noteId, target, resolverRevision),
        );
        if (!cached) {
            results.set(target, "pending");
            continue;
        }

        results.set(target, cached.noteId ? "valid" : "broken");
    }

    scheduleBatchResolution(noteId, uniqueTargets, onResolved);
    return results;
}

export function resolveWikilink(target: string): boolean {
    const noteId = getActiveNoteId();
    return resolveWikilinksBatch(noteId, [target]).get(target) === "valid";
}

export async function findNoteByWikilink(
    target: string,
    noteId: string | null = getActiveNoteId(),
): Promise<ResolvedNoteMatch | null> {
    if (!noteId) return null;

    const { resolverRevision } = ensureFreshResolverCache();
    const cacheKey = makeCacheKey(noteId, target, resolverRevision);
    const cached = resolutionCache.get(cacheKey);
    if (cached) {
        return cached.noteId
            ? { id: cached.noteId, title: cached.title }
            : null;
    }

    const startMs = perfNow();
    const results = await vaultInvoke<ResolvedWikilinkDto[]>(
        "resolve_wikilinks_batch",
        {
            noteId,
            targets: [target],
        },
    );
    perfMeasure("editor.wikilinkResolver.backend.single.duration", startMs, {
        targetCount: 1,
    });

    const resolved = results[0];
    resolutionCache.set(cacheKey, {
        noteId: resolved?.resolved_note_id ?? null,
        title: resolved?.resolved_title ?? null,
    });

    return resolved?.resolved_note_id
        ? {
              id: resolved.resolved_note_id,
              title: resolved.resolved_title,
          }
        : null;
}

export function matchesRevealTarget(target: string, revealTargets: string[]) {
    const targetVariants = new Set(getWikilinkVariants(target));
    return revealTargets.some((candidate) =>
        getWikilinkVariants(candidate).some((variant) =>
            targetVariants.has(variant),
        ),
    );
}
