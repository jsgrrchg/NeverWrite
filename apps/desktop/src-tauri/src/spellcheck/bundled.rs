pub struct BundledDictionaryMetadata {
    pub version: &'static str,
    pub homepage: &'static str,
    pub license: &'static str,
    pub aff: &'static str,
    pub dic: &'static str,
    pub license_text: &'static str,
    pub readme_text: &'static str,
}

const EN_US_AFF: &str = include_str!("bundled/en-US/dictionary.aff");
const EN_US_DIC: &str = include_str!("bundled/en-US/dictionary.dic");
const EN_US_LICENSE: &str = include_str!("bundled/en-US/LICENSE.txt");
const EN_US_README: &str = include_str!("bundled/en-US/README.txt");

const ES_ES_AFF: &str = include_str!("bundled/es-ES/dictionary.aff");
const ES_ES_DIC: &str = include_str!("bundled/es-ES/dictionary.dic");
const ES_ES_LICENSE: &str = include_str!("bundled/es-ES/LICENSE.txt");
const ES_ES_README: &str = include_str!("bundled/es-ES/README.txt");

pub fn bundled_dictionary(language: &str) -> Option<BundledDictionaryMetadata> {
    match language {
        "en-US" => Some(BundledDictionaryMetadata {
            version: "2026.03.15",
            homepage: "http://wordlist.sourceforge.net",
            license: "LGPL-2.1+ wordlist; BSD-style affix file",
            aff: EN_US_AFF,
            dic: EN_US_DIC,
            license_text: EN_US_LICENSE,
            readme_text: EN_US_README,
        }),
        "es-ES" => Some(BundledDictionaryMetadata {
            version: "2026.03.15",
            homepage: "https://github.com/LibreOffice/dictionaries",
            license: "GPL-3.0+ / LGPL-3.0+ / MPL-1.1+",
            aff: ES_ES_AFF,
            dic: ES_ES_DIC,
            license_text: ES_ES_LICENSE,
            readme_text: ES_ES_README,
        }),
        _ => None,
    }
}
