import { invoke } from "@neverwrite/runtime";
import type {
    SpellcheckLanguage,
    SpellcheckSecondaryLanguage,
} from "../../app/store/settingsStore";
import type {
    GrammarCheckResponse,
    SpellcheckCatalogEntry,
    SpellcheckCatalogMutationResponse,
    SpellcheckCheckTextResponse,
    SpellcheckDictionaryMutationResponse,
    SpellcheckLanguageInfo,
    SpellcheckSuggestionResponse,
} from "./types";

function normalizeLanguageTagCase(value: string) {
    const normalized = value.trim().replace(/_/g, "-");
    if (!normalized) {
        return "";
    }

    return normalized
        .split("-")
        .filter(Boolean)
        .map((segment, index) => {
            if (index === 0) {
                return segment.toLowerCase();
            }

            if (/^[A-Za-z]{2}$/.test(segment)) {
                return segment.toUpperCase();
            }

            if (/^\d+$/.test(segment)) {
                return segment;
            }

            return segment[0]?.toUpperCase() + segment.slice(1).toLowerCase();
        })
        .join("-");
}

function normalizePrimaryLanguageAlias(value: string) {
    switch (value.toLowerCase()) {
        case "en":
            return "en-US";
        case "es":
            return "es-ES";
        default:
            return value;
    }
}

function buildLanguageFallbackCandidates(languageTag: string) {
    const normalized = normalizePrimaryLanguageAlias(
        normalizeLanguageTagCase(languageTag),
    );
    if (!normalized) {
        return ["en-US"];
    }

    const candidates: string[] = [];
    const pushCandidate = (candidate: string) => {
        const normalizedCandidate = normalizePrimaryLanguageAlias(
            normalizeLanguageTagCase(candidate),
        );
        if (normalizedCandidate && !candidates.includes(normalizedCandidate)) {
            candidates.push(normalizedCandidate);
        }
    };

    pushCandidate(normalized);

    const segments = normalized.split("-").filter(Boolean);
    while (segments.length > 1) {
        segments.pop();
        pushCandidate(segments.join("-"));
    }

    return candidates;
}

export function resolveFrontendSpellcheckLanguageCandidates(
    language: SpellcheckLanguage,
) {
    const trimmed = language.trim();
    if (trimmed.toLowerCase() === "system") {
        const systemCandidate = normalizeLanguageTagCase(
            typeof navigator !== "undefined"
                ? navigator.language || "en-US"
                : "en-US",
        );

        return buildLanguageFallbackCandidates(systemCandidate);
    }

    return buildLanguageFallbackCandidates(trimmed || "en-US");
}

export function normalizeSpellcheckLanguageTag(language: SpellcheckLanguage) {
    return resolveFrontendSpellcheckLanguageCandidates(language)[0] ?? "en-US";
}

export function resolveFrontendSpellcheckLanguage(
    language: SpellcheckLanguage,
) {
    return normalizeSpellcheckLanguageTag(language);
}

export function resolveFrontendSpellcheckSecondaryLanguage(
    language: SpellcheckSecondaryLanguage,
) {
    if (!language) {
        return null;
    }

    return normalizeSpellcheckLanguageTag(language);
}

export function spellcheckListLanguages() {
    return invoke<SpellcheckLanguageInfo[]>("spellcheck_list_languages");
}

export function spellcheckListCatalog() {
    return invoke<SpellcheckCatalogEntry[]>("spellcheck_list_catalog");
}

export function spellcheckCheckText(
    text: string,
    language: SpellcheckLanguage,
    secondaryLanguage: SpellcheckSecondaryLanguage = null,
) {
    return invoke<SpellcheckCheckTextResponse>("spellcheck_check_text", {
        text,
        language: resolveFrontendSpellcheckLanguage(language),
        secondaryLanguage:
            resolveFrontendSpellcheckSecondaryLanguage(secondaryLanguage),
    });
}

export function spellcheckSuggest(
    word: string,
    language: SpellcheckLanguage,
    secondaryLanguage: SpellcheckSecondaryLanguage = null,
) {
    return invoke<SpellcheckSuggestionResponse>("spellcheck_suggest", {
        word,
        language: resolveFrontendSpellcheckLanguage(language),
        secondaryLanguage:
            resolveFrontendSpellcheckSecondaryLanguage(secondaryLanguage),
    });
}

export function spellcheckAddToDictionary(
    word: string,
    language: SpellcheckLanguage,
) {
    return invoke<SpellcheckDictionaryMutationResponse>(
        "spellcheck_add_to_dictionary",
        {
            word,
            language: resolveFrontendSpellcheckLanguage(language),
        },
    );
}

export function spellcheckRemoveFromDictionary(
    word: string,
    language: SpellcheckLanguage,
) {
    return invoke<SpellcheckDictionaryMutationResponse>(
        "spellcheck_remove_from_dictionary",
        {
            word,
            language: resolveFrontendSpellcheckLanguage(language),
        },
    );
}

export function spellcheckIgnoreWord(
    word: string,
    language: SpellcheckLanguage,
) {
    return invoke<SpellcheckDictionaryMutationResponse>(
        "spellcheck_ignore_word",
        {
            word,
            language: resolveFrontendSpellcheckLanguage(language),
        },
    );
}

export function spellcheckGetRuntimeDirectory() {
    return invoke<string>("spellcheck_get_runtime_directory");
}

export function spellcheckInstallDictionary(language: string) {
    return invoke<SpellcheckCatalogMutationResponse>(
        "spellcheck_install_dictionary",
        { language },
    );
}

export function spellcheckRemoveInstalledDictionary(language: string) {
    return invoke<SpellcheckCatalogMutationResponse>(
        "spellcheck_remove_installed_dictionary",
        { language },
    );
}

export function spellcheckCheckGrammar(
    text: string,
    language: SpellcheckLanguage,
    serverUrl?: string,
) {
    const normalizedServerUrl = serverUrl?.trim();

    return invoke<GrammarCheckResponse>("spellcheck_check_grammar", {
        text,
        language: resolveFrontendSpellcheckLanguage(language),
        serverUrl: normalizedServerUrl || undefined,
    });
}
