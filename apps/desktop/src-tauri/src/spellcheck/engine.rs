use std::collections::HashSet;

use spellbook::Dictionary;

use super::bundled::bundled_dictionary;
use super::types::{
    SpellcheckCheckTextResponse, SpellcheckDiagnostic, SpellcheckLanguageSelection,
    SpellcheckSuggestionResponse,
};

#[derive(Debug, Clone)]
pub struct DictionaryBundle {
    pub language: String,
    pub dictionary: Dictionary,
}

#[derive(Debug, Clone)]
pub struct DictionarySelection {
    pub primary: DictionaryBundle,
    pub secondary: Option<DictionaryBundle>,
}

pub struct HunspellDictionaryFiles {
    pub aff: String,
    pub dic: String,
}

#[derive(Debug)]
struct Token {
    start_utf16: usize,
    end_utf16: usize,
    raw: String,
}

pub fn bundled_hunspell_files_for_language(language: &str) -> Option<HunspellDictionaryFiles> {
    let bundled = bundled_dictionary(language)?;

    Some(HunspellDictionaryFiles {
        aff: bundled.aff.to_string(),
        dic: bundled.dic.to_string(),
    })
}

pub fn load_hunspell_bundle(
    language: &str,
    aff_content: &str,
    dic_content: &str,
    extra_words: impl IntoIterator<Item = String>,
) -> Result<DictionaryBundle, String> {
    let mut dictionary =
        Dictionary::new(aff_content, dic_content).map_err(|error| error.to_string())?;

    for word in extra_words {
        if let Some(normalized) = normalize_dictionary_word(&word) {
            dictionary
                .add(&normalized)
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(DictionaryBundle {
        language: language.to_string(),
        dictionary,
    })
}

pub fn normalize_dictionary_word(word: &str) -> Option<String> {
    let normalized = normalize_word(word);
    if normalized.is_empty() || normalized.chars().any(char::is_whitespace) {
        return None;
    }

    if !normalized
        .chars()
        .all(|ch| ch.is_alphabetic() || matches!(ch, '\'' | '’' | '-'))
    {
        return None;
    }

    should_check_word(&normalized).then_some(normalized)
}

pub fn check_text_spelling(
    text: &str,
    selection: &DictionarySelection,
    ignored_session_words: &HashSet<String>,
) -> SpellcheckCheckTextResponse {
    let diagnostics = tokenize_words(text)
        .into_iter()
        .filter(|token| should_check_word(&token.raw))
        .filter(|token| {
            let normalized = normalize_word(&token.raw);
            let primary_correct = selection.primary.dictionary.check(&token.raw);
            let secondary_correct = selection
                .secondary
                .as_ref()
                .is_some_and(|bundle| bundle.dictionary.check(&token.raw));
            !normalized.is_empty()
                && !primary_correct
                && !secondary_correct
                && !ignored_session_words.contains(&ignored_session_key(&normalized))
        })
        .map(|token| SpellcheckDiagnostic {
            start_utf16: token.start_utf16,
            end_utf16: token.end_utf16,
            word: token.raw,
        })
        .collect();

    SpellcheckCheckTextResponse {
        language: selection.primary.language.clone(),
        secondary_language: selection
            .secondary
            .as_ref()
            .map(|bundle| bundle.language.clone()),
        diagnostics,
    }
}

pub fn build_suggestions(
    word: &str,
    selection: &DictionarySelection,
) -> SpellcheckSuggestionResponse {
    let primary_correct = selection.primary.dictionary.check(word);
    let secondary_correct = selection
        .secondary
        .as_ref()
        .is_some_and(|bundle| bundle.dictionary.check(word));
    let correct = primary_correct || secondary_correct;
    let mut suggestions = Vec::new();
    selection.primary.dictionary.suggest(word, &mut suggestions);
    if let Some(secondary) = &selection.secondary {
        let mut secondary_suggestions = Vec::new();
        secondary
            .dictionary
            .suggest(word, &mut secondary_suggestions);
        suggestions.extend(secondary_suggestions);
    }
    suggestions.dedup();
    suggestions.truncate(6);

    SpellcheckSuggestionResponse {
        language: selection.primary.language.clone(),
        secondary_language: selection
            .secondary
            .as_ref()
            .map(|bundle| bundle.language.clone()),
        word: word.to_string(),
        correct,
        suggestions,
    }
}

pub fn build_dictionary_selection(
    languages: &SpellcheckLanguageSelection,
    primary: DictionaryBundle,
    secondary: Option<DictionaryBundle>,
) -> DictionarySelection {
    DictionarySelection {
        primary,
        secondary: secondary.filter(|bundle| {
            languages
                .secondary
                .as_ref()
                .is_some_and(|language| bundle.language == *language)
        }),
    }
}

pub fn ignored_session_key(word: &str) -> String {
    word.to_string()
}

fn should_check_word(word: &str) -> bool {
    let letter_count = word.chars().filter(|ch| ch.is_alphabetic()).count();
    letter_count >= 2
}

fn normalize_word(word: &str) -> String {
    word.trim_matches(|ch: char| !ch.is_alphabetic() && ch != '\'' && ch != '’')
        .to_lowercase()
}

fn tokenize_words(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut current_start = None;
    let mut current_utf16_start = 0usize;
    let mut current_word = String::new();
    let mut utf16_index = 0usize;
    let mut previous_was_letter = false;

    for ch in text.chars() {
        let is_joiner = matches!(ch, '\'' | '’' | '-');
        let starts_or_continues_word = ch.is_alphabetic() || (is_joiner && previous_was_letter);

        if starts_or_continues_word {
            if current_start.is_none() {
                current_start = Some(utf16_index);
                current_utf16_start = utf16_index;
                current_word.clear();
            }

            current_word.push(ch);
        } else if current_start.is_some() {
            tokens.push(Token {
                start_utf16: current_utf16_start,
                end_utf16: utf16_index,
                raw: current_word.clone(),
            });
            current_start = None;
            current_word.clear();
        }

        previous_was_letter = ch.is_alphabetic();
        utf16_index += ch.len_utf16();
    }

    if current_start.is_some() {
        tokens.push(Token {
            start_utf16: current_utf16_start,
            end_utf16: utf16_index,
            raw: current_word,
        });
    }

    tokens
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        build_dictionary_selection, build_suggestions, check_text_spelling, load_hunspell_bundle,
        normalize_dictionary_word, DictionaryBundle,
    };
    use crate::spellcheck::types::SpellcheckLanguageSelection;

    fn bundle(words: &[&str]) -> DictionaryBundle {
        load_hunspell_bundle(
            "en-US",
            "SET UTF-8\nTRY esiarntolcdugmphbyfvkwzxjq\n",
            &format!("{}\n{}\n", words.len(), words.join("\n")),
            std::iter::empty(),
        )
        .expect("should build test dictionary")
    }

    #[test]
    fn finds_misspelled_words_with_utf16_offsets() {
        let result = check_text_spelling(
            "hello wrld adios",
            &build_dictionary_selection(
                &SpellcheckLanguageSelection {
                    primary: "en-US".to_string(),
                    secondary: None,
                },
                bundle(&["hello", "world", "adios"]),
                None,
            ),
            &HashSet::new(),
        );
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].word, "wrld");
        assert_eq!(result.diagnostics[0].start_utf16, 6);
        assert_eq!(result.diagnostics[0].end_utf16, 10);
    }

    #[test]
    fn normalizes_valid_dictionary_words() {
        assert_eq!(
            normalize_dictionary_word("  O'Brien "),
            Some("o'brien".to_string())
        );
        assert_eq!(
            normalize_dictionary_word("mother-in-law"),
            Some("mother-in-law".to_string())
        );
    }

    #[test]
    fn rejects_invalid_dictionary_words() {
        assert_eq!(normalize_dictionary_word("hello world"), None);
        assert_eq!(normalize_dictionary_word("x"), None);
        assert_eq!(normalize_dictionary_word("123"), None);
    }

    #[test]
    fn builds_suggestions_from_dictionary_words() {
        let response = build_suggestions(
            "wrld",
            &build_dictionary_selection(
                &SpellcheckLanguageSelection {
                    primary: "en-US".to_string(),
                    secondary: None,
                },
                bundle(&["hello", "world", "word"]),
                None,
            ),
        );
        assert_eq!(response.correct, false);
        assert!(response.suggestions.contains(&"world".to_string()));
    }

    #[test]
    fn accepts_words_from_secondary_dictionary() {
        let result = check_text_spelling(
            "hola world",
            &build_dictionary_selection(
                &SpellcheckLanguageSelection {
                    primary: "es-ES".to_string(),
                    secondary: Some("en-US".to_string()),
                },
                bundle(&["hola"]),
                Some(bundle(&["world"])),
            ),
            &HashSet::new(),
        );

        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn loads_hunspell_dictionary_entries_and_extra_words() {
        let bundle = load_hunspell_bundle(
            "en-US",
            "SET UTF-8\nTRY abc\n",
            "3\nhello\nworld/AB\nadios\n",
            ["custom".to_string()],
        )
        .expect("should load hunspell files");

        assert!(bundle.dictionary.check("hello"));
        assert!(bundle.dictionary.check("world"));
        assert!(bundle.dictionary.check("adios"));
        assert!(bundle.dictionary.check("custom"));
    }

    #[test]
    fn rejects_invalid_aff_files() {
        let error = load_hunspell_bundle("en-US", "PFX\n", "1\nhello\n", [])
            .expect_err("should reject invalid aff");
        assert!(!error.is_empty());
    }
}
