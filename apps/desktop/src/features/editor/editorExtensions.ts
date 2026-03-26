import {
    Decoration,
    EditorView,
    type ViewUpdate,
    ViewPlugin,
    lineNumbers,
} from "@codemirror/view";
import { Compartment, RangeSetBuilder } from "@codemirror/state";
import {
    syntaxTree,
    syntaxHighlighting,
    defaultHighlightStyle,
} from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type {
    EditorFontFamily,
    SpellcheckLanguage,
    SpellcheckSecondaryLanguage,
} from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { livePreviewExtension } from "./extensions/livePreview";
import { resolveWikilink } from "./wikilinkResolution";
import { navigateWikilink, getNoteLinkTarget } from "./wikilinkNavigation";
import { resolveFrontendSpellcheckLanguage } from "../spellcheck/api";

export type LinkContextMenuState = {
    x: number;
    y: number;
    href: string;
    noteTarget: string | null;
};

const editorHorizontalInset =
    "max(clamp(24px, 5vw, 56px), calc((100% - var(--editor-content-width)) / 2))";
const editorLineNumberGutterWidth = "44px";

export const baseTheme = EditorView.theme({
    "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--text-primary)",
        fontSize: "var(--editor-font-size)",
        fontFamily: "var(--editor-font-family)",
    },
    ".cm-scroller": {
        overflow: "hidden auto",
        fontFamily: "inherit",
        flexWrap: "wrap",
        paddingBottom: "72px",
        scrollbarColor: "var(--app-scrollbar-thumb) transparent",
        minWidth: 0,
        overflowAnchor: "auto",
    },
    '&[data-line-wrapping="false"] .cm-scroller': {
        overflowX: "auto",
        overflowY: "auto",
    },
    ".cm-lp-scroll-header": {
        flex: "0 0 100%",
        boxSizing: "border-box",
    },
    ".cm-content": {
        flex: "1 1 0%",
        minWidth: 0,
        boxSizing: "border-box",
        padding: `24px ${editorHorizontalInset} 120px`,
        caretColor: "var(--text-primary)",
        lineHeight: "var(--text-input-line-height)",
        minHeight: "calc(100vh - 220px)",
    },
    ".cm-line": {
        padding: "0 2px",
    },
    '&[data-scrollbar-dragging="true"] .cm-content, &[data-scrollbar-dragging="true"] .cm-content *':
        {
            userSelect: "none",
            WebkitUserSelect: "none",
        },
    ".cm-gutters": {
        display: "none",
        backgroundColor: "transparent",
        border: "none",
        color: "var(--text-secondary)",
        boxSizing: "border-box",
        flexShrink: 0,
    },
    '&[data-live-preview="false"] .cm-gutters': {
        display: "flex",
        width: editorLineNumberGutterWidth,
        minWidth: editorLineNumberGutterWidth,
        marginLeft: `max(0px, calc(${editorHorizontalInset} - ${editorLineNumberGutterWidth}))`,
        pointerEvents: "none",
    },
    '&[data-live-preview="false"] .cm-content': {
        paddingLeft: "0",
    },
    '&[data-live-preview="false"] .cm-lineNumbers': {
        minWidth: editorLineNumberGutterWidth,
    },
    '&[data-live-preview="false"] .cm-lineNumbers .cm-gutterElement': {
        minWidth: "3ch",
        padding: "0 14px 0 0",
        textAlign: "right",
        lineHeight: "var(--text-input-line-height)",
    },
    '&[data-live-preview="false"] .cm-source-heading, &[data-live-preview="false"] .cm-source-heading *':
        {
            textDecoration: "none",
        },
    ".cm-cursor": {
        borderLeftColor: "var(--text-primary)",
        borderLeftWidth: "2px",
        marginLeft: "-1px",
        padding: "2px 0",
    },
    ".cm-selectionBackground": {
        backgroundColor:
            "color-mix(in srgb, var(--accent) 22%, transparent) !important",
    },
    ".cm-line::selection, .cm-line > span::selection, .cm-content ::selection":
        {
            backgroundColor: "transparent",
        },
    ".cm-line::-moz-selection, .cm-line > span::-moz-selection, .cm-content ::-moz-selection":
        {
            backgroundColor: "transparent",
        },
    ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--accent) 3.5%, transparent)",
        borderRadius: "8px",
    },
    ".cm-activeLineGutter": {
        backgroundColor: "transparent",
    },
    "&.cm-focused": {
        outline: "none",
    },
});

// Compartment for syntax highlighting (switches between dark/light)
export const syntaxCompartment = new Compartment();
// Compartment for the live preview extension (reconfigured when vault changes)
export const livePreviewCompartment = new Compartment();
// Compartment for justified alignment
export const alignmentCompartment = new Compartment();
// Compartment for line wrapping
export const wrappingCompartment = new Compartment();
// Compartment for tab size
export const tabSizeCompartment = new Compartment();
// Compartment for spellcheck attributes
export const spellcheckCompartment = new Compartment();
// Compartment for app-owned spellcheck decorations
export const spellcheckDecorationsCompartment = new Compartment();
// Compartment for grammar check decorations
export const grammarDecorationsCompartment = new Compartment();

const sourceHeadingDecoration = Decoration.mark({
    class: "cm-source-heading",
});

function buildSourceHeadingDecorations(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>();

    syntaxTree(view.state).iterate({
        from: 0,
        to: view.state.doc.length,
        enter(node) {
            if (
                node.name.startsWith("ATXHeading") ||
                node.name.startsWith("SetextHeading")
            ) {
                builder.add(node.from, node.to, sourceHeadingDecoration);
            }
        },
    });

    return builder.finish();
}

const sourceHeadingDecorationExtension = ViewPlugin.fromClass(
    class {
        decorations;

        constructor(view: EditorView) {
            this.decorations = buildSourceHeadingDecorations(view);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = buildSourceHeadingDecorations(update.view);
            }
        }
    },
    {
        decorations: (plugin) => plugin.decorations,
    },
);

export function getSyntaxExtension(isDark: boolean) {
    // Only switch syntax highlighting colors, not the full editor theme
    return [
        syntaxHighlighting(
            isDark ? oneDarkHighlightStyle : defaultHighlightStyle,
        ),
        sourceHeadingDecorationExtension,
    ];
}

export function getLivePreviewExtension(
    openLinkContextMenu: (menu: LinkContextMenuState | null) => void,
    enabled = true,
) {
    if (!enabled) {
        return [
            EditorView.editorAttributes.of({
                "data-live-preview": "false",
            }),
            lineNumbers(),
        ];
    }
    const vaultPath = useVaultStore.getState().vaultPath;
    return [
        EditorView.editorAttributes.of({
            "data-live-preview": "true",
        }),
        livePreviewExtension(vaultPath, {
            resolveWikilink,
            navigateWikilink,
            getNoteLinkTarget,
            openLinkContextMenu,
        }),
    ];
}

export function getAlignmentExtension(enabled: boolean) {
    return enabled
        ? [
              EditorView.contentAttributes.of({
                  class: "cm-justify-text",
              }),
              EditorView.theme({
                  ".cm-content.cm-justify-text .cm-line": {
                      width: "100%",
                      textAlign: "justify",
                      textAlignLast: "left",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "break-word",
                      wordBreak: "normal",
                      hyphens: "auto",
                  },
              }),
          ]
        : [];
}

export function getWrappingExtension(enabled: boolean) {
    return enabled
        ? [
              EditorView.lineWrapping,
              EditorView.editorAttributes.of({
                  "data-line-wrapping": "true",
              }),
          ]
        : [
              EditorView.editorAttributes.of({
                  "data-line-wrapping": "false",
              }),
          ];
}

export function getSpellcheckExtension(
    enabled: boolean,
    primaryLanguage: SpellcheckLanguage,
    secondaryLanguage: SpellcheckSecondaryLanguage,
    noteId: string | null | undefined,
) {
    const active = enabled && typeof noteId === "string" && noteId.length > 0;
    const resolvedLanguage = active
        ? resolveFrontendSpellcheckLanguage(primaryLanguage)
        : undefined;
    const resolvedSecondaryLanguage =
        active && secondaryLanguage
            ? resolveFrontendSpellcheckLanguage(secondaryLanguage)
            : undefined;

    return EditorView.contentAttributes.of({
        spellcheck: "false",
        "data-spellcheck-engine": active ? "app" : "off",
        ...(resolvedLanguage
            ? { "data-spellcheck-language": resolvedLanguage }
            : {}),
        ...(resolvedSecondaryLanguage
            ? {
                  "data-spellcheck-secondary-language":
                      resolvedSecondaryLanguage,
              }
            : {}),
    });
}

export function getEditorFontFamily(fontFamily: EditorFontFamily) {
    switch (fontFamily) {
        case "sans":
            return '"Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif';
        case "serif":
            return '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif';
        case "mono":
            return '"SFMono-Regular", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace';
        case "courier":
            return '"Courier New", Courier, "Nimbus Mono PS", monospace';
        case "reading":
            return '"Charter", "Baskerville", "Georgia", serif';
        case "rounded":
            return '"SF Pro Rounded", "Nunito", "Avenir Next Rounded", "Hiragino Maru Gothic ProN", sans-serif';
        case "humanist":
            return '"Optima", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif';
        case "slab":
            return '"Rockwell", "Clarendon Text", "Roboto Slab", "Courier Prime", serif';
        case "typewriter":
            return '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace';
        case "newspaper":
            return '"Times New Roman", "Georgia", "Source Serif 4", "Iowan Old Style", serif';
        case "condensed":
            return '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif';
        case "andale":
            return '"Andale Mono", Menlo, Monaco, Consolas, monospace';
        case "system":
        default:
            return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    }
}
