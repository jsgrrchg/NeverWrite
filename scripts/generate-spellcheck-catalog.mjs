#!/usr/bin/env node

/**
 * Generates apps/desktop/native-backend/resources/spellcheck/catalog.json
 *
 * Sources:
 *   1. wooorm/dictionaries (primary, ~80 UTF-8 Hunspell dictionaries)
 *   2. LibreOffice/dictionaries (complementary, languages not in wooorm)
 *
 * Usage:
 *   node scripts/generate-spellcheck-catalog.mjs                  # fast, no hashes
 *   node scripts/generate-spellcheck-catalog.mjs --compute-hashes # download + SHA256
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_OUTPUT = resolve(
    __dirname,
    "../apps/desktop/native-backend/resources/spellcheck/catalog.json",
);

const WOOORM_BASE =
    "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries";
const LIBREOFFICE_BASE =
    "https://raw.githubusercontent.com/LibreOffice/dictionaries/master";

const computeHashes = process.argv.includes("--compute-hashes");

const EXISTING_CATALOG = existsSync(CATALOG_OUTPUT)
    ? JSON.parse(readFileSync(CATALOG_OUTPUT, "utf-8"))
    : [];
const existingEntriesById = new Map(
    EXISTING_CATALOG.map((entry) => [entry.id, entry]),
);

function getExistingIntegrityMetadata(entry) {
    const existing = existingEntriesById.get(entry.id);
    if (!existing) return null;
    if (
        existing.version !== entry.version ||
        existing.aff_url !== entry.aff_url ||
        existing.dic_url !== entry.dic_url
    ) {
        return null;
    }
    return existing;
}

function withExistingIntegrityMetadata(entry) {
    const existing = getExistingIntegrityMetadata(entry);
    if (!existing) {
        return entry;
    }

    return {
        ...entry,
        size_bytes: entry.size_bytes || existing.size_bytes || 0,
        aff_sha256: entry.aff_sha256 || existing.aff_sha256 || "",
        dic_sha256: entry.dic_sha256 || existing.dic_sha256 || "",
        license_url: entry.license_url || existing.license_url || "",
        readme_url: entry.readme_url || existing.readme_url || "",
    };
}

// ---------- Bundled entries (kept as-is from current catalog) ----------

const BUNDLED = [
    {
        id: "en-US",
        label: "English (US)",
        version: "2026.03.15",
        source: "LibreOffice / SCOWL",
        license: "LGPL-2.1+ wordlist; BSD-style affix file",
        homepage: "http://wordlist.sourceforge.net",
        bundled: true,
        size_bytes: 554967,
        aff_url: `${LIBREOFFICE_BASE}/en/en_US.aff`,
        dic_url: `${LIBREOFFICE_BASE}/en/en_US.dic`,
        license_url: `${LIBREOFFICE_BASE}/en/license.txt`,
        readme_url: `${LIBREOFFICE_BASE}/en/README_en_US.txt`,
        aff_sha256: "",
        dic_sha256: "",
    },
    {
        id: "es-ES",
        label: "Spanish (Spain)",
        version: "2026.03.15",
        source: "LibreOffice / RLA-ES",
        license: "GPL-3.0+ / LGPL-3.0+ / MPL-1.1+",
        homepage: "https://github.com/LibreOffice/dictionaries",
        bundled: true,
        size_bytes: 885191,
        aff_url: `${LIBREOFFICE_BASE}/es/es_ES.aff`,
        dic_url: `${LIBREOFFICE_BASE}/es/es_ES.dic`,
        license_url: `${LIBREOFFICE_BASE}/es/LICENSE.md`,
        readme_url: `${LIBREOFFICE_BASE}/es/README_hunspell_es.txt`,
        aff_sha256: "",
        dic_sha256: "",
    },
];

// ---------- wooorm/dictionaries: code → label mapping ----------

const WOOORM_LANGUAGES = [
    // Western Europe
    { id: "fr", label: "French" },
    { id: "de", label: "German" },
    { id: "de-AT", label: "German (Austria)" },
    { id: "de-CH", label: "German (Switzerland)" },
    { id: "it", label: "Italian" },
    { id: "pt", label: "Portuguese (Brazil)" },
    { id: "pt-PT", label: "Portuguese (Portugal)" },
    { id: "nl", label: "Dutch" },
    { id: "ca", label: "Catalan" },
    { id: "ca-valencia", label: "Catalan (Valencia)" },
    { id: "gl", label: "Galician" },
    { id: "eu", label: "Basque" },
    { id: "oc", label: "Occitan" },
    { id: "lb", label: "Luxembourgish" },
    { id: "fur", label: "Friulian" },
    { id: "fy", label: "Western Frisian" },
    { id: "br", label: "Breton" },
    // British Isles
    { id: "en", label: "English" },
    { id: "en-AU", label: "English (Australia)" },
    { id: "en-CA", label: "English (Canada)" },
    { id: "en-GB", label: "English (United Kingdom)" },
    { id: "en-ZA", label: "English (South Africa)" },
    { id: "ga", label: "Irish" },
    { id: "gd", label: "Scottish Gaelic" },
    { id: "cy", label: "Welsh" },
    // Scandinavia and the Baltics
    { id: "da", label: "Danish" },
    { id: "sv", label: "Swedish" },
    { id: "nb", label: "Norwegian Bokmål" },
    { id: "nn", label: "Norwegian Nynorsk" },
    { id: "is", label: "Icelandic" },
    { id: "fo", label: "Faroese" },
    { id: "et", label: "Estonian" },
    { id: "lt", label: "Lithuanian" },
    { id: "ltg", label: "Latgalian" },
    { id: "lv", label: "Latvian" },
    // Central and Eastern Europe
    { id: "pl", label: "Polish" },
    { id: "cs", label: "Czech" },
    { id: "sk", label: "Slovak" },
    { id: "hu", label: "Hungarian" },
    { id: "ro", label: "Romanian" },
    { id: "bg", label: "Bulgarian" },
    { id: "hr", label: "Croatian" },
    { id: "sl", label: "Slovenian" },
    { id: "sr", label: "Serbian (Cyrillic)" },
    { id: "sr-Latn", label: "Serbian (Latin)" },
    { id: "mk", label: "Macedonian" },
    // Russia and former USSR
    { id: "ru", label: "Russian" },
    { id: "uk", label: "Ukrainian" },
    { id: "hy", label: "Armenian" },
    { id: "hyw", label: "Western Armenian" },
    { id: "ka", label: "Georgian" },
    { id: "mn", label: "Mongolian" },
    { id: "tk", label: "Turkmen" },
    // Middle East
    { id: "he", label: "Hebrew" },
    { id: "fa", label: "Persian" },
    { id: "tr", label: "Turkish" },
    // South Asia
    { id: "ne", label: "Nepali" },
    // East and Southeast Asia
    { id: "ko", label: "Korean" },
    { id: "vi", label: "Vietnamese" },
    // Africa
    { id: "rw", label: "Kinyarwanda" },
    // Latin America (non-bundled variants)
    { id: "es", label: "Spanish" },
    { id: "es-AR", label: "Spanish (Argentina)" },
    { id: "es-CL", label: "Spanish (Chile)" },
    { id: "es-CO", label: "Spanish (Colombia)" },
    { id: "es-MX", label: "Spanish (Mexico)" },
    { id: "es-VE", label: "Spanish (Venezuela)" },
    // Constructed and classical languages
    { id: "eo", label: "Esperanto" },
    { id: "ia", label: "Interlingua" },
    { id: "ie", label: "Interlingue" },
    { id: "la", label: "Latin" },
    { id: "nds", label: "Low German" },
    { id: "tlh", label: "Klingon" },
];

// ---------- Helpers ----------

async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

async function fetchHashAndSize(url) {
    if (!computeHashes) return { sha256: "", size_bytes: 0 };
    const buffer = await fetchBytes(url);
    return { sha256: sha256(buffer), size_bytes: buffer.length };
}

// ---------- Build wooorm entries ----------

async function buildWoormEntry(lang) {
    const affUrl = `${WOOORM_BASE}/${lang.id}/index.aff`;
    const dicUrl = `${WOOORM_BASE}/${lang.id}/index.dic`;

    let affHash = "";
    let dicHash = "";
    let totalSize = 0;

    const baseEntry = {
        id: lang.id,
        label: lang.label,
        version: "2026.03.15",
        source: "wooorm/dictionaries",
        license: "MIT",
        homepage: `https://github.com/wooorm/dictionaries/tree/main/dictionaries/${lang.id}`,
        bundled: false,
        size_bytes: totalSize,
        aff_url: affUrl,
        dic_url: dicUrl,
        license_url: "",
        readme_url: "",
        aff_sha256: affHash,
        dic_sha256: dicHash,
    };

    if (computeHashes) {
        console.log(`  Fetching ${lang.id}...`);
        try {
            const [affData, dicData] = await Promise.all([
                fetchHashAndSize(affUrl),
                fetchHashAndSize(dicUrl),
            ]);
            affHash = affData.sha256;
            dicHash = dicData.sha256;
            totalSize = affData.size_bytes + dicData.size_bytes;
        } catch (error) {
            console.warn(
                `  WARNING: Could not fetch ${lang.id}: ${error.message}`,
            );
            return withExistingIntegrityMetadata(baseEntry);
        }
    }

    return withExistingIntegrityMetadata({
        ...baseEntry,
        size_bytes: totalSize,
        aff_sha256: affHash,
        dic_sha256: dicHash,
    });
}

// ---------- Build LibreOffice extras ----------

async function buildLibreOfficeEntry(lang) {
    const affUrl = `${LIBREOFFICE_BASE}/${lang.folder}/${lang.aff_file ?? `${lang.locale}.aff`}`;
    const dicUrl = `${LIBREOFFICE_BASE}/${lang.folder}/${lang.dic_file ?? `${lang.locale}.dic`}`;

    let affHash = "";
    let dicHash = "";
    let totalSize = 0;

    const baseEntry = {
        id: lang.id,
        label: lang.label,
        version: "2026.03.15",
        source: "LibreOffice",
        license: lang.license,
        homepage: `https://github.com/LibreOffice/dictionaries/tree/master/${lang.folder}`,
        bundled: false,
        size_bytes: totalSize,
        aff_url: affUrl,
        dic_url: dicUrl,
        license_url: "",
        readme_url: "",
        aff_sha256: affHash,
        dic_sha256: dicHash,
    };

    if (computeHashes) {
        console.log(`  Fetching ${lang.id} (LibreOffice)...`);
        try {
            const [affData, dicData] = await Promise.all([
                fetchHashAndSize(affUrl),
                fetchHashAndSize(dicUrl),
            ]);
            affHash = affData.sha256;
            dicHash = dicData.sha256;
            totalSize = affData.size_bytes + dicData.size_bytes;
        } catch (error) {
            console.warn(
                `  WARNING: Could not fetch ${lang.id}: ${error.message}`,
            );
            return withExistingIntegrityMetadata(baseEntry);
        }
    }

    return withExistingIntegrityMetadata({
        ...baseEntry,
        size_bytes: totalSize,
        aff_sha256: affHash,
        dic_sha256: dicHash,
    });
}

// ---------- Main ----------

async function main() {
    console.log(
        `Generating spellcheck catalog (hashes: ${computeHashes ? "yes" : "no"})...`,
    );

    const libreOfficeExtras = JSON.parse(
        readFileSync(resolve(__dirname, "libreoffice-extras.json"), "utf-8"),
    );

    // Build wooorm entries
    console.log(`Building ${WOOORM_LANGUAGES.length} wooorm entries...`);
    const woormEntries = [];
    for (const lang of WOOORM_LANGUAGES) {
        const entry = await buildWoormEntry(lang);
        if (entry) woormEntries.push(entry);
    }

    // Build LibreOffice extras
    console.log(`Building ${libreOfficeExtras.length} LibreOffice extras...`);
    const libreEntries = [];
    for (const lang of libreOfficeExtras) {
        const entry = await buildLibreOfficeEntry(lang);
        if (entry) libreEntries.push(entry);
    }

    const catalog = [
        ...BUNDLED.map((entry) => withExistingIntegrityMetadata(entry)),
        ...woormEntries,
        ...libreEntries,
    ];

    // Sort: bundled first, then alphabetically by label
    catalog.sort((a, b) => {
        if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
        return a.label.localeCompare(b.label, "en");
    });

    writeFileSync(CATALOG_OUTPUT, JSON.stringify(catalog, null, 2) + "\n");

    console.log(`\nWrote ${catalog.length} entries to ${CATALOG_OUTPUT}`);
    console.log(`  Bundled: ${catalog.filter((e) => e.bundled).length}`);
    console.log(`  Downloadable: ${catalog.filter((e) => !e.bundled).length}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
