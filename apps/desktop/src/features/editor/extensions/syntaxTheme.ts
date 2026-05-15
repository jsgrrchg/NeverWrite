import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// CodeMirror HighlightStyle that references the per-theme `--code-*` CSS
// variables published by `applyThemeColors`. Because the highlight rules
// resolve through `var(...)`, switching themes only requires updating the
// CSS vars on `:root` — no need to rebuild or reconfigure the
// HighlightStyle, and `themeName` never leaks into the editor extension
// graph. Coverage mirrors the static highlighter in
// `staticCodeHighlight.tsx` so source mode and rendered code stay aligned.

type CodeSyntaxClass =
    | "comment"
    | "constant"
    | "escape"
    | "function"
    | "keyword"
    | "markup"
    | "parameter"
    | "property"
    | "string"
    | "type"
    | "typeParameter"
    | "variable";

const CODE_VAR_NAME: Record<CodeSyntaxClass, string> = {
    comment: "--code-comment",
    constant: "--code-constant",
    escape: "--code-escape",
    function: "--code-function",
    keyword: "--code-keyword",
    markup: "--code-markup",
    parameter: "--code-parameter",
    property: "--code-property",
    string: "--code-string",
    type: "--code-type",
    typeParameter: "--code-type-parameter",
    variable: "--code-variable",
};

function codeVar(slot: CodeSyntaxClass): string {
    return `var(${CODE_VAR_NAME[slot]})`;
}

export function buildSyntaxHighlightStyle(): HighlightStyle {
    return HighlightStyle.define([
        {
            tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
            color: codeVar("comment"),
            fontStyle: "italic",
        },
        {
            tag: [
                t.keyword,
                t.controlKeyword,
                t.operatorKeyword,
                t.modifier,
                t.definitionKeyword,
                t.moduleKeyword,
            ],
            color: codeVar("keyword"),
        },
        {
            tag: [t.string, t.docString, t.character, t.attributeValue],
            color: codeVar("string"),
        },
        {
            tag: [t.special(t.string), t.escape, t.regexp],
            color: codeVar("escape"),
        },
        {
            tag: [
                t.number,
                t.integer,
                t.float,
                t.bool,
                t.atom,
                t.null,
                t.literal,
                t.unit,
                t.color,
            ],
            color: codeVar("constant"),
        },
        {
            tag: [t.typeName, t.className, t.namespace, t.macroName],
            color: codeVar("type"),
        },
        { tag: t.typeOperator, color: codeVar("typeParameter") },
        {
            tag: [
                t.function(t.variableName),
                t.function(t.propertyName),
                t.function(t.className),
                t.function(t.labelName),
            ],
            color: codeVar("function"),
        },
        {
            tag: [t.propertyName, t.definition(t.propertyName)],
            color: codeVar("property"),
        },
        {
            tag: [
                t.attributeName,
                t.definition(t.attributeName),
                t.local(t.variableName),
            ],
            color: codeVar("parameter"),
        },
        {
            tag: [
                t.name,
                t.variableName,
                t.definition(t.variableName),
                t.labelName,
            ],
            color: codeVar("variable"),
        },
        {
            tag: [
                t.tagName,
                t.definition(t.tagName),
                t.heading,
                t.heading1,
                t.heading2,
                t.heading3,
                t.heading4,
                t.heading5,
                t.heading6,
            ],
            color: codeVar("markup"),
        },
        {
            tag: [
                t.operator,
                t.derefOperator,
                t.arithmeticOperator,
                t.logicOperator,
                t.bitwiseOperator,
                t.compareOperator,
                t.updateOperator,
                t.definitionOperator,
                t.controlOperator,
            ],
            color: codeVar("keyword"),
        },
        // Brackets and structural punctuation match the static highlighter's
        // `cm-static-token-punctuation` bucket so the two surfaces agree.
        {
            tag: [
                t.punctuation,
                t.separator,
                t.bracket,
                t.paren,
                t.squareBracket,
                t.brace,
                t.angleBracket,
            ],
            color: codeVar("markup"),
        },
        { tag: t.strong, fontWeight: "700" },
        { tag: t.emphasis, fontStyle: "italic" },
        { tag: t.strikethrough, textDecoration: "line-through" },
        {
            tag: [t.link, t.url],
            color: codeVar("function"),
            textDecoration: "underline",
        },
        { tag: t.monospace, color: codeVar("string") },
        {
            tag: [t.meta, t.documentMeta, t.annotation, t.processingInstruction],
            color: codeVar("comment"),
        },
        {
            tag: t.invalid,
            color: codeVar("markup"),
            textDecoration: "underline",
        },
    ]);
}
