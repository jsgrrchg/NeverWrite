import { create } from "zustand";
import {
    spellcheckAddToDictionary,
    spellcheckCheckText,
    spellcheckGetRuntimeDirectory,
    spellcheckIgnoreWord,
    spellcheckInstallDictionary,
    spellcheckListCatalog,
    spellcheckListLanguages,
    spellcheckRemoveInstalledDictionary,
    spellcheckRemoveFromDictionary,
    spellcheckSuggest,
    resolveFrontendSpellcheckLanguage,
    resolveFrontendSpellcheckSecondaryLanguage,
} from "./api";
import {
    useSettingsStore,
    type SpellcheckLanguage,
    type SpellcheckSecondaryLanguage,
} from "../../app/store/settingsStore";
import type {
    SpellcheckCatalogEntry,
    SpellcheckCatalogMutationResponse,
    SpellcheckCheckDocumentInput,
    SpellcheckDictionaryMutationResponse,
    SpellcheckDocumentCacheEntry,
    SpellcheckLanguageInfo,
    SpellcheckSuggestionResponse,
} from "./types";

type SpellcheckState = {
    enabled: boolean;
    requestedPrimaryLanguage: SpellcheckLanguage;
    requestedSecondaryLanguage: SpellcheckSecondaryLanguage;
    resolvedPrimaryLanguage: string;
    resolvedSecondaryLanguage: string | null;
    languages: SpellcheckLanguageInfo[];
    catalog: SpellcheckCatalogEntry[];
    runtimeDirectory: string | null;
    lastError: string | null;
    documentCache: Map<string, SpellcheckDocumentCacheEntry>;
    ignoredSessionWords: Set<string>;
    syncFromSettings: (
        enabled: boolean,
        primaryLanguage: SpellcheckLanguage,
        secondaryLanguage: SpellcheckSecondaryLanguage,
    ) => void;
    loadLanguages: () => Promise<SpellcheckLanguageInfo[]>;
    loadCatalog: () => Promise<SpellcheckCatalogEntry[]>;
    loadRuntimeDirectory: () => Promise<string>;
    checkDocument: (
        input: SpellcheckCheckDocumentInput,
    ) => Promise<SpellcheckDocumentCacheEntry>;
    suggestWord: (
        word: string,
        language?: SpellcheckLanguage,
    ) => Promise<SpellcheckSuggestionResponse>;
    addWordToDictionary: (
        word: string,
        language?: SpellcheckLanguage,
    ) => Promise<SpellcheckDictionaryMutationResponse>;
    removeWordFromDictionary: (
        word: string,
        language?: SpellcheckLanguage,
    ) => Promise<SpellcheckDictionaryMutationResponse>;
    ignoreWordForSession: (
        word: string,
        language?: SpellcheckLanguage,
    ) => Promise<SpellcheckDictionaryMutationResponse>;
    installCatalogDictionary: (
        language: string,
    ) => Promise<SpellcheckCatalogMutationResponse>;
    removeInstalledCatalogDictionary: (
        language: string,
    ) => Promise<SpellcheckCatalogMutationResponse>;
    isWordIgnored: (word: string) => boolean;
    invalidateDocument: (documentId: string) => void;
    invalidateAllDocuments: () => void;
};

function createDocumentCacheKey(documentId: string) {
    return documentId;
}

function normalizeIgnoredWord(word: string) {
    return word.trim().toLowerCase();
}

function cloneIgnoredWords(current: Set<string>, nextWord?: string) {
    const next = new Set(current);
    if (nextWord) {
        next.add(nextWord);
    }
    return next;
}

function getInitialState() {
    const settings = useSettingsStore.getState();
    return {
        enabled: settings.editorSpellcheck,
        requestedPrimaryLanguage: settings.spellcheckPrimaryLanguage,
        requestedSecondaryLanguage: settings.spellcheckSecondaryLanguage,
        resolvedPrimaryLanguage: resolveFrontendSpellcheckLanguage(
            settings.spellcheckPrimaryLanguage,
        ),
        resolvedSecondaryLanguage: resolveFrontendSpellcheckSecondaryLanguage(
            settings.spellcheckSecondaryLanguage,
        ),
        languages: [],
        catalog: [],
        runtimeDirectory: null,
        lastError: null,
        documentCache: new Map<string, SpellcheckDocumentCacheEntry>(),
        ignoredSessionWords: new Set<string>(),
    };
}

export const useSpellcheckStore = create<SpellcheckState>((set, get) => ({
    ...getInitialState(),

    syncFromSettings: (enabled, primaryLanguage, secondaryLanguage) => {
        set({
            enabled,
            requestedPrimaryLanguage: primaryLanguage,
            requestedSecondaryLanguage: secondaryLanguage,
            resolvedPrimaryLanguage:
                resolveFrontendSpellcheckLanguage(primaryLanguage),
            resolvedSecondaryLanguage:
                resolveFrontendSpellcheckSecondaryLanguage(secondaryLanguage),
            documentCache: new Map(),
        });
    },

    loadLanguages: async () => {
        try {
            const languages = await spellcheckListLanguages();
            set({ languages, lastError: null });
            return languages;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    loadCatalog: async () => {
        try {
            const catalog = await spellcheckListCatalog();
            set({ catalog, lastError: null });
            return catalog;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    loadRuntimeDirectory: async () => {
        try {
            const runtimeDirectory = await spellcheckGetRuntimeDirectory();
            set({ runtimeDirectory, lastError: null });
            return runtimeDirectory;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    checkDocument: async ({
        documentId,
        version,
        text,
        language,
        secondaryLanguage,
        force = false,
    }) => {
        const requestedLanguage = language ?? get().requestedPrimaryLanguage;
        const requestedSecondaryLanguage =
            secondaryLanguage ?? get().requestedSecondaryLanguage;
        const resolvedLanguage =
            resolveFrontendSpellcheckLanguage(requestedLanguage);
        const resolvedSecondaryLanguage =
            resolveFrontendSpellcheckSecondaryLanguage(
                requestedSecondaryLanguage,
            );
        const cacheKey = createDocumentCacheKey(
            `${documentId}:${resolvedLanguage}:${resolvedSecondaryLanguage ?? "none"}`,
        );
        const cached = get().documentCache.get(cacheKey);

        if (
            !force &&
            cached &&
            cached.version === version &&
            cached.language === resolvedLanguage &&
            cached.secondaryLanguage === resolvedSecondaryLanguage
        ) {
            return cached;
        }

        try {
            const response = await spellcheckCheckText(
                text,
                requestedLanguage,
                requestedSecondaryLanguage,
            );
            const entry: SpellcheckDocumentCacheEntry = {
                documentId,
                version,
                language: response.language,
                secondaryLanguage: response.secondary_language,
                diagnostics: response.diagnostics,
            };

            set((state) => {
                const nextCache = new Map(state.documentCache);
                nextCache.set(cacheKey, entry);
                return {
                    documentCache: nextCache,
                    lastError: null,
                };
            });

            return entry;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    suggestWord: async (word, language) => {
        const requestedLanguage = language ?? get().requestedPrimaryLanguage;
        const requestedSecondaryLanguage = get().requestedSecondaryLanguage;

        try {
            const response = await spellcheckSuggest(
                word,
                requestedLanguage,
                requestedSecondaryLanguage,
            );
            set({ lastError: null });
            return response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    addWordToDictionary: async (word, language) => {
        const requestedLanguage = language ?? get().requestedPrimaryLanguage;

        try {
            const response = await spellcheckAddToDictionary(
                word,
                requestedLanguage,
            );
            get().invalidateAllDocuments();
            set({ lastError: null });
            return response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    removeWordFromDictionary: async (word, language) => {
        const requestedLanguage = language ?? get().requestedPrimaryLanguage;

        try {
            const response = await spellcheckRemoveFromDictionary(
                word,
                requestedLanguage,
            );
            get().invalidateAllDocuments();
            set({ lastError: null });
            return response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    ignoreWordForSession: async (word, language) => {
        const requestedLanguage = language ?? get().requestedPrimaryLanguage;
        const normalizedWord = normalizeIgnoredWord(word);

        try {
            const response = await spellcheckIgnoreWord(
                word,
                requestedLanguage,
            );
            set((state) => ({
                ignoredSessionWords: cloneIgnoredWords(
                    state.ignoredSessionWords,
                    normalizedWord,
                ),
                documentCache: new Map(),
                lastError: null,
            }));
            return response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    installCatalogDictionary: async (language) => {
        try {
            const response = await spellcheckInstallDictionary(language);
            get().invalidateAllDocuments();
            await Promise.all([get().loadLanguages(), get().loadCatalog()]);
            set({ lastError: null });
            return response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    removeInstalledCatalogDictionary: async (language) => {
        try {
            const response =
                await spellcheckRemoveInstalledDictionary(language);
            get().invalidateAllDocuments();
            await Promise.all([get().loadLanguages(), get().loadCatalog()]);
            set({ lastError: null });
            return response;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            set({ lastError: message });
            throw error;
        }
    },

    isWordIgnored: (word) => {
        const normalizedWord = normalizeIgnoredWord(word);
        return get().ignoredSessionWords.has(normalizedWord);
    },

    invalidateDocument: (documentId) => {
        set((state) => {
            const nextCache = new Map(state.documentCache);
            for (const key of nextCache.keys()) {
                if (key === documentId || key.startsWith(`${documentId}:`)) {
                    nextCache.delete(key);
                }
            }
            return { documentCache: nextCache };
        });
    },

    invalidateAllDocuments: () => {
        set({ documentCache: new Map() });
    },
}));

function syncSpellcheckStoreFromSettings() {
    const settings = useSettingsStore.getState();
    useSpellcheckStore
        .getState()
        .syncFromSettings(
            settings.editorSpellcheck,
            settings.spellcheckPrimaryLanguage,
            settings.spellcheckSecondaryLanguage,
        );
}

syncSpellcheckStoreFromSettings();

useSettingsStore.subscribe((state) => {
    useSpellcheckStore
        .getState()
        .syncFromSettings(
            state.editorSpellcheck,
            state.spellcheckPrimaryLanguage,
            state.spellcheckSecondaryLanguage,
        );
});
