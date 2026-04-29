export type SearchValue = string | number | null | undefined;

export interface SettingsSearchQuery {
    readonly normalized: string;
    readonly terms: readonly string[];
}

export const EMPTY_SEARCH_QUERY: SettingsSearchQuery = {
    normalized: "",
    terms: [],
};

export function createSettingsSearchQuery(value: string): SettingsSearchQuery {
    const normalized = normalizeSearchText(value);

    if (!normalized) {
        return EMPTY_SEARCH_QUERY;
    }

    return {
        normalized,
        terms: normalized.split(" ").filter(Boolean),
    };
}

export function normalizeSearchText(value: SearchValue): string {
    return String(value ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function matchesSettingsSearch(
    query: SettingsSearchQuery,
    ...values: readonly SearchValue[]
): boolean {
    if (query.terms.length === 0) {
        return true;
    }

    const haystack = normalizeSearchText(
        values
            .filter((value) => value !== null && value !== undefined)
            .join(" "),
    );

    return query.terms.every((term) => haystack.includes(term));
}

export function sectionHasSettingsSearchMatches(
    searchQuery: SettingsSearchQuery,
    section: string,
    rows: readonly (readonly SearchValue[])[],
): boolean {
    return rows.some((row) =>
        matchesSettingsSearch(searchQuery, section, ...row),
    );
}
