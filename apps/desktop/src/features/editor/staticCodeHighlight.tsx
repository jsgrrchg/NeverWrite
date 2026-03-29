import { LanguageSupport, type Language } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { useMemo, type ReactNode } from "react";

type HighlightSegment = {
    text: string;
    className: string | null;
};

type CodeLanguage = Language;

const staticTokenHighlighter = tagHighlighter([
    {
        tag: [
            tags.comment,
            tags.lineComment,
            tags.blockComment,
            tags.docComment,
        ],
        class: "cm-static-token-comment",
    },
    {
        tag: [
            tags.keyword,
            tags.controlKeyword,
            tags.operatorKeyword,
            tags.definitionKeyword,
            tags.moduleKeyword,
        ],
        class: "cm-static-token-keyword",
    },
    {
        tag: [tags.name, tags.variableName],
        class: "cm-static-token-variable",
    },
    {
        tag: [
            tags.definition(tags.variableName),
            tags.definition(tags.propertyName),
            tags.definition(tags.tagName),
            tags.definition(tags.attributeName),
            tags.labelName,
        ],
        class: "cm-static-token-definition",
    },
    {
        tag: [
            tags.function(tags.variableName),
            tags.function(tags.propertyName),
            tags.function(tags.className),
            tags.function(tags.labelName),
        ],
        class: "cm-static-token-function",
    },
    {
        tag: [tags.className, tags.typeName, tags.namespace, tags.macroName],
        class: "cm-static-token-type",
    },
    {
        tag: [tags.propertyName],
        class: "cm-static-token-property",
    },
    {
        tag: [tags.tagName],
        class: "cm-static-token-tag",
    },
    {
        tag: [tags.attributeName],
        class: "cm-static-token-attribute",
    },
    {
        tag: [tags.attributeValue],
        class: "cm-static-token-attribute-value",
    },
    {
        tag: [
            tags.string,
            tags.special(tags.string),
            tags.regexp,
            tags.character,
        ],
        class: "cm-static-token-string",
    },
    {
        tag: [tags.number, tags.integer, tags.float],
        class: "cm-static-token-number",
    },
    {
        tag: [tags.bool, tags.atom, tags.null],
        class: "cm-static-token-atom",
    },
    {
        tag: [
            tags.operator,
            tags.derefOperator,
            tags.arithmeticOperator,
            tags.logicOperator,
            tags.bitwiseOperator,
            tags.compareOperator,
            tags.updateOperator,
            tags.definitionOperator,
            tags.typeOperator,
            tags.controlOperator,
        ],
        class: "cm-static-token-operator",
    },
    {
        tag: [
            tags.punctuation,
            tags.separator,
            tags.paren,
            tags.squareBracket,
            tags.brace,
            tags.angleBracket,
        ],
        class: "cm-static-token-punctuation",
    },
    {
        tag: [tags.meta, tags.processingInstruction, tags.documentMeta],
        class: "cm-static-token-meta",
    },
    {
        tag: [tags.escape],
        class: "cm-static-token-escape",
    },
    {
        tag: [tags.invalid],
        class: "cm-static-token-invalid",
    },
]);

function toLanguage(
    language: LanguageSupport | CodeLanguage | null,
): CodeLanguage | null {
    if (!language) {
        return null;
    }
    return language instanceof LanguageSupport ? language.language : language;
}

function buildHighlightSegments(
    text: string,
    language: CodeLanguage | null,
): HighlightSegment[] {
    if (!text) {
        return [];
    }

    if (!language) {
        return [{ text, className: null }];
    }

    const tree = language.parser.parse(text);
    const segments: HighlightSegment[] = [];
    let cursor = 0;

    highlightTree(tree, staticTokenHighlighter, (from, to, classes) => {
        if (from > cursor) {
            segments.push({
                text: text.slice(cursor, from),
                className: null,
            });
        }
        if (to > from) {
            segments.push({
                text: text.slice(from, to),
                className: classes || null,
            });
        }
        cursor = to;
    });

    if (cursor < text.length) {
        segments.push({
            text: text.slice(cursor),
            className: null,
        });
    }

    return segments;
}

function renderHighlightSegments(
    segments: HighlightSegment[],
    keyPrefix: string,
): ReactNode {
    return segments.map((segment, index) =>
        segment.className ? (
            <span key={`${keyPrefix}:${index}`} className={segment.className}>
                {segment.text}
            </span>
        ) : (
            <span key={`${keyPrefix}:${index}`}>{segment.text}</span>
        ),
    );
}

export function HighlightedCodeText({
    text,
    language,
    segmentKeyPrefix = "cm-static",
}: {
    text: string;
    language: LanguageSupport | CodeLanguage | null;
    segmentKeyPrefix?: string;
}) {
    const segments = useMemo(
        () => buildHighlightSegments(text, toLanguage(language)),
        [language, text],
    );

    return (
        <span className="cm-static-code">
            {renderHighlightSegments(segments, segmentKeyPrefix)}
        </span>
    );
}
