import {
    safeStorageGetItem,
    safeStorageRemoveItem,
    safeStorageSetItem,
} from "../../app/utils/safeStorage";

const KEY = "neverwrite.search.history";
const MAX_ENTRIES = 20;

export function getSearchHistory(): string[] {
    try {
        const raw = safeStorageGetItem(KEY);
        if (!raw) return [];
        return JSON.parse(raw) as string[];
    } catch {
        return [];
    }
}

export function addToSearchHistory(query: string): void {
    const trimmed = query.trim();
    if (!trimmed) return;

    const history = getSearchHistory().filter((q) => q !== trimmed);
    history.unshift(trimmed);

    if (history.length > MAX_ENTRIES) {
        history.length = MAX_ENTRIES;
    }

    safeStorageSetItem(KEY, JSON.stringify(history));
}

export function removeFromSearchHistory(query: string): void {
    const history = getSearchHistory().filter((q) => q !== query);
    safeStorageSetItem(KEY, JSON.stringify(history));
}

export function clearSearchHistory(): void {
    safeStorageRemoveItem(KEY);
}
