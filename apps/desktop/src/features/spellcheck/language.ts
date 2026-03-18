import type {
    SpellcheckLanguage,
    SpellcheckSecondaryLanguage,
} from "../../app/store/settingsStore";
import {
    resolveFrontendSpellcheckLanguage,
    resolveFrontendSpellcheckLanguageCandidates,
} from "./api";
import type { SpellcheckLanguageInfo } from "./types";

export type SpellcheckLanguageSelectOption = {
    value: string | null;
    label: string;
};

function getLanguageFamily(languageTag: string) {
    return (
        languageTag.split("-")[0]?.toLowerCase() ?? languageTag.toLowerCase()
    );
}

function getSystemLanguageTag() {
    if (typeof navigator === "undefined") {
        return "en-US";
    }

    return navigator.language || "en-US";
}

export function getSpellcheckLanguageStatusLabel(
    language: Pick<SpellcheckLanguageInfo, "available" | "source">,
) {
    if (!language.available) {
        return "Not installed";
    }

    switch (language.source) {
        case "installed":
        case "custom-installed":
        case "installed-pack":
        case "legacy-installed":
            return "Installed";
        case "embedded-bootstrap":
        case "bundled-pack":
            return "Bundled";
        default:
            return "Available";
    }
}

function formatDictionarySize(sizeBytes: number | null) {
    if (!sizeBytes || sizeBytes <= 0) {
        return null;
    }

    if (sizeBytes >= 1024 * 1024) {
        return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${Math.round(sizeBytes / 1024)} KB`;
}

function compareSpellcheckLanguages(
    left: SpellcheckLanguageInfo,
    right: SpellcheckLanguageInfo,
) {
    const leftInstalled =
        getSpellcheckLanguageStatusLabel(left) === "Installed";
    const rightInstalled =
        getSpellcheckLanguageStatusLabel(right) === "Installed";

    if (leftInstalled !== rightInstalled) {
        return leftInstalled ? -1 : 1;
    }

    return left.label.localeCompare(right.label, "en");
}

export function buildSpellcheckLanguageSelectOptions(
    requestedLanguage: SpellcheckLanguage,
    languages: SpellcheckLanguageInfo[],
): SpellcheckLanguageSelectOption[] {
    const systemTag = getSystemLanguageTag();
    const resolvedSystemCandidates =
        resolveFrontendSpellcheckLanguageCandidates("system");
    const resolvedSystemLanguage = resolvedSystemCandidates[0] ?? systemTag;
    const systemLabel =
        resolvedSystemLanguage === systemTag
            ? `System (${systemTag})`
            : `System (${systemTag} -> ${resolvedSystemLanguage})`;

    const options: SpellcheckLanguageSelectOption[] = [
        { value: "system", label: systemLabel },
        ...[...languages].sort(compareSpellcheckLanguages).map((language) => ({
            value: language.id,
            label: `${language.label} · ${getSpellcheckLanguageStatusLabel(language)}`,
        })),
    ];

    if (
        requestedLanguage !== "system" &&
        !languages.some((language) => language.id === requestedLanguage)
    ) {
        options.push({
            value: requestedLanguage,
            label: `${requestedLanguage} · Not installed`,
        });
    }

    return options;
}

export function buildSpellcheckSecondaryLanguageSelectOptions(
    primaryLanguage: SpellcheckLanguage,
    secondaryLanguage: SpellcheckSecondaryLanguage,
    languages: SpellcheckLanguageInfo[],
): SpellcheckLanguageSelectOption[] {
    const excludedPrimaryLanguages = new Set(
        resolveFrontendSpellcheckLanguageCandidates(primaryLanguage),
    );
    const excludedPrimaryFamilies = new Set(
        [...excludedPrimaryLanguages].map(getLanguageFamily),
    );
    const options: SpellcheckLanguageSelectOption[] = [
        { value: null, label: "None" },
        ...[...languages]
            .filter(
                (language) =>
                    !excludedPrimaryLanguages.has(language.id) &&
                    !excludedPrimaryFamilies.has(
                        getLanguageFamily(language.id),
                    ),
            )
            .sort(compareSpellcheckLanguages)
            .map((language) => ({
                value: language.id,
                label: `${language.label} · ${getSpellcheckLanguageStatusLabel(language)}`,
            })),
    ];

    if (
        secondaryLanguage &&
        !languages.some((language) => language.id === secondaryLanguage)
    ) {
        options.push({
            value: secondaryLanguage,
            label: `${secondaryLanguage} · Not installed`,
        });
    }

    return options;
}

export function buildSpellcheckLanguageDescription(
    requestedLanguage: SpellcheckLanguage,
    languages: SpellcheckLanguageInfo[],
    runtimeDirectory: string | null,
) {
    if (requestedLanguage === "system") {
        const systemTag = getSystemLanguageTag();
        const resolvedSystemCandidates =
            resolveFrontendSpellcheckLanguageCandidates(requestedLanguage);
        const resolvedSystemLanguage = resolvedSystemCandidates[0] ?? systemTag;
        const fallbackSuffix =
            resolvedSystemCandidates.length > 1
                ? ` Runtime may fall back to ${resolvedSystemCandidates
                      .slice(1)
                      .join(
                          " or ",
                      )} if a more specific dictionary is unavailable.`
                : "";

        return resolvedSystemLanguage === systemTag
            ? `Primary spellcheck language follows your OS language: ${systemTag}.${fallbackSuffix}`
            : `Primary spellcheck language follows your OS language: ${systemTag}, resolved to ${resolvedSystemLanguage}.${fallbackSuffix}`;
    }

    const selectedLanguage = languages.find(
        (language) => language.id === requestedLanguage,
    );

    if (selectedLanguage) {
        const status = getSpellcheckLanguageStatusLabel(selectedLanguage);
        const details = [
            selectedLanguage.version
                ? `Version ${selectedLanguage.version}`
                : null,
            formatDictionarySize(selectedLanguage.size_bytes),
            selectedLanguage.license
                ? `License ${selectedLanguage.license}`
                : null,
        ].filter(Boolean);

        return `${selectedLanguage.label} is the primary spellcheck language and is ${status.toLowerCase()}.${
            details.length > 0 ? ` ${details.join(" · ")}.` : ""
        }`;
    }

    const installDirectory = runtimeDirectory
        ? `${runtimeDirectory}/packs/${requestedLanguage}`
        : `<spellcheck>/packs/${requestedLanguage}`;
    const systemTag = getSystemLanguageTag();
    const fallbackLanguage = resolveFrontendSpellcheckLanguage("system");

    return `${requestedLanguage} is selected as the primary spellcheck language but is not installed. Runtime will fall back to System (${systemTag} -> ${fallbackLanguage}) until a Hunspell pack with dictionary.aff and dictionary.dic is available at ${installDirectory}.`;
}

export function buildSpellcheckSecondaryLanguageDescription(
    secondaryLanguage: SpellcheckSecondaryLanguage,
    languages: SpellcheckLanguageInfo[],
    runtimeDirectory: string | null,
) {
    if (!secondaryLanguage) {
        return "Optional secondary dictionary used to accept words from a second language.";
    }

    const selectedLanguage = languages.find(
        (language) => language.id === secondaryLanguage,
    );

    if (selectedLanguage) {
        const status = getSpellcheckLanguageStatusLabel(selectedLanguage);
        const details = [
            selectedLanguage.version
                ? `Version ${selectedLanguage.version}`
                : null,
            formatDictionarySize(selectedLanguage.size_bytes),
            selectedLanguage.license
                ? `License ${selectedLanguage.license}`
                : null,
        ].filter(Boolean);

        return `${selectedLanguage.label} is the current secondary spellcheck language and is ${status.toLowerCase()}.${
            details.length > 0 ? ` ${details.join(" · ")}.` : ""
        }`;
    }

    const installDirectory = runtimeDirectory
        ? `${runtimeDirectory}/packs/${secondaryLanguage}`
        : `<spellcheck>/packs/${secondaryLanguage}`;

    return `${secondaryLanguage} is selected as the secondary spellcheck language but is not installed. Runtime will ignore the secondary dictionary and continue with only the primary language until a Hunspell pack with dictionary.aff and dictionary.dic is available at ${installDirectory}.`;
}

export function buildSpellcheckLanguagesSummary(
    languages: SpellcheckLanguageInfo[],
) {
    const installedCount = languages.filter(
        (language) =>
            getSpellcheckLanguageStatusLabel(language) === "Installed",
    ).length;
    const builtInCount = languages.filter(
        (language) => getSpellcheckLanguageStatusLabel(language) === "Bundled",
    ).length;
    const bundledSize = languages.reduce((total, language) => {
        if (getSpellcheckLanguageStatusLabel(language) !== "Bundled") {
            return total;
        }

        return total + (language.size_bytes ?? 0);
    }, 0);

    if (languages.length === 0) {
        return "No dictionaries detected yet";
    }

    const parts = [];
    if (installedCount > 0) {
        parts.push(`${installedCount} installed`);
    }
    if (builtInCount > 0) {
        const bundledLabel = `${builtInCount} bundled`;
        const bundledSizeLabel = formatDictionarySize(bundledSize);
        parts.push(
            bundledSizeLabel
                ? `${bundledLabel} (${bundledSizeLabel})`
                : bundledLabel,
        );
    }

    return parts.join(" · ");
}
