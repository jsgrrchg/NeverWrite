import type {
    SpellcheckLanguage,
    SpellcheckSecondaryLanguage,
} from "../../app/store/settingsStore";

export interface SpellcheckDiagnostic {
    start_utf16: number;
    end_utf16: number;
    word: string;
}

export interface SpellcheckCheckTextResponse {
    language: string;
    secondary_language: string | null;
    diagnostics: SpellcheckDiagnostic[];
}

export interface SpellcheckSuggestionResponse {
    language: string;
    secondary_language: string | null;
    word: string;
    correct: boolean;
    suggestions: string[];
}

export interface SpellcheckLanguageInfo {
    id: string;
    label: string;
    available: boolean;
    source: string;
    dictionary_path: string | null;
    user_dictionary_path: string;
    aff_path: string | null;
    dic_path: string | null;
    version: string | null;
    size_bytes: number | null;
    license: string | null;
    homepage: string | null;
}

export interface SpellcheckDictionaryMutationResponse {
    language: string;
    word: string;
    updated: boolean;
    user_dictionary_path: string;
}

export interface SpellcheckCatalogEntry {
    id: string;
    label: string;
    version: string;
    installed_version: string | null;
    source: string;
    license: string;
    homepage: string;
    bundled: boolean;
    size_bytes: number;
    installed: boolean;
    update_available: boolean;
    install_status: string;
}

export interface SpellcheckCatalogMutationResponse {
    language: string;
    installed: boolean;
    install_path: string | null;
}

export interface SpellcheckDocumentCacheEntry {
    documentId: string;
    version: string;
    language: string;
    secondaryLanguage: string | null;
    diagnostics: SpellcheckDiagnostic[];
}

export interface SpellcheckCheckDocumentInput {
    documentId: string;
    version: string;
    text: string;
    language?: SpellcheckLanguage;
    secondaryLanguage?: SpellcheckSecondaryLanguage;
    force?: boolean;
}

export interface SpellcheckSuggestInput {
    word: string;
    language?: SpellcheckLanguage;
}
