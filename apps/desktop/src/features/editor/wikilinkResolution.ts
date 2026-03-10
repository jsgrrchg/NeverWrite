import { useVaultStore } from "../../app/store/vaultStore";

type VaultNote = ReturnType<typeof useVaultStore.getState>["notes"][number];

let cachedNotesRef: VaultNote[] | null = null;
let cachedWikilinkIndex: Map<string, VaultNote> | null = null;
let cachedWikilinkResolution: Map<string, VaultNote | null> | null = null;
let cachedVaultPath: string | null = null;

export function invalidateWikilinkCaches() {
    cachedNotesRef = null;
    cachedWikilinkIndex = null;
    cachedWikilinkResolution = null;
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

function isStrongPrefixCandidate(target: string): boolean {
    return target.length >= 24 && target.split(/\s+/).length >= 4;
}

function isPrefixExpansion(candidate: string, target: string): boolean {
    if (candidate === target || !candidate.startsWith(target)) {
        return false;
    }

    const next = candidate.charAt(target.length);
    return next === " " || next === "-" || next === ":" || next === "(";
}

function findUniquePrefixNote(
    target: string,
    notes: VaultNote[],
): VaultNote | null {
    const variants = getWikilinkVariants(target).filter(
        isStrongPrefixCandidate,
    );
    if (!variants.length) return null;

    const matches: VaultNote[] = [];

    for (const note of notes) {
        const aliases = [
            normalizeWikilinkTarget(note.title),
            normalizeWikilinkTarget(note.id.split("/").pop() ?? ""),
        ];

        if (
            !aliases.some((alias) =>
                variants.some((variant) => isPrefixExpansion(alias, variant)),
            )
        ) {
            continue;
        }

        matches.push(note);
        if (matches.length > 1) return null;
    }

    return matches[0] ?? null;
}

function getWikilinkIndex(): Map<string, VaultNote> {
    const currentVaultPath = useVaultStore.getState().vaultPath;
    if (currentVaultPath !== cachedVaultPath) {
        invalidateWikilinkCaches();
        cachedVaultPath = currentVaultPath;
    }

    const notes = useVaultStore.getState().notes;
    if (cachedNotesRef === notes && cachedWikilinkIndex) {
        return cachedWikilinkIndex;
    }

    const index = new Map<string, VaultNote>();
    for (const note of notes) {
        const fullId = normalizeWikilinkTarget(note.id);
        const title = normalizeWikilinkTarget(note.title);
        const lastSegment = normalizeWikilinkTarget(
            note.id.split("/").pop() ?? "",
        );

        for (const key of getWikilinkVariants(fullId)) {
            if (!index.has(key)) index.set(key, note);
        }
        for (const key of getWikilinkVariants(title)) {
            if (!index.has(key)) index.set(key, note);
        }
        for (const key of getWikilinkVariants(lastSegment)) {
            if (!index.has(key)) index.set(key, note);
        }
    }

    cachedNotesRef = notes;
    cachedWikilinkIndex = index;
    cachedWikilinkResolution = new Map();
    return index;
}

export function findNoteByWikilink(target: string) {
    const index = getWikilinkIndex();
    // cachedWikilinkResolution is always initialized by getWikilinkIndex()
    const resolutionCache = cachedWikilinkResolution!;
    const variants = getWikilinkVariants(target);
    const cacheKey = variants.join("\u0000");
    const cachedMatch = resolutionCache.get(cacheKey);
    if (cachedMatch !== undefined) {
        return cachedMatch;
    }

    let resolved: VaultNote | null = null;
    for (const key of variants) {
        const match = index.get(key);
        if (match) {
            resolved = match;
            break;
        }
    }

    if (!resolved) {
        resolved = findUniquePrefixNote(target, useVaultStore.getState().notes);
    }

    resolutionCache.set(cacheKey, resolved);
    return resolved;
}

export function resolveWikilink(target: string): boolean {
    return findNoteByWikilink(target) !== null;
}

export function matchesRevealTarget(target: string, revealTargets: string[]) {
    const targetVariants = new Set(getWikilinkVariants(target));
    return revealTargets.some((candidate) =>
        getWikilinkVariants(candidate).some((variant) =>
            targetVariants.has(variant),
        ),
    );
}
