/**
 * CSS theme for inline diff decorations in the CodeMirror editor.
 *
 * Uses CSS variables from index.css (--diff-add, --diff-remove, --diff-update)
 * so colors automatically adapt to light/dark mode.
 *
 * Instead of relying on the gutter (which is hidden in live preview),
 * we use an inset shadow so the diff indicator doesn't shift line layout.
 */

import { EditorView } from "@codemirror/view";

export const inlineDiffTheme = EditorView.baseTheme({
    // ── Added / modified line backgrounds with left border stripe ─────
    ".cm-diff-added": {
        backgroundColor: "color-mix(in srgb, var(--diff-add) 18%, transparent)",
        boxShadow: "inset 3px 0 0 0 var(--diff-add)",
        transition: "background-color 160ms ease, box-shadow 160ms ease",
    },
    ".cm-diff-modified": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 18%, transparent)",
        boxShadow: "inset 3px 0 0 0 var(--diff-update)",
        transition: "background-color 160ms ease, box-shadow 160ms ease",
    },
    ".cm-diff-inline-add": {
        backgroundColor: "color-mix(in srgb, var(--diff-add) 28%, transparent)",
        borderRadius: "3px",
        boxDecorationBreak: "clone",
        transition: "background-color 160ms ease, opacity 160ms ease",
    },
    ".cm-diff-inline-modified": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 28%, transparent)",
        borderRadius: "3px",
        boxDecorationBreak: "clone",
        transition: "background-color 160ms ease, opacity 160ms ease",
    },
    ".cm-diff-word-changed": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 18%, transparent)",
        borderRadius: "3px",
        boxDecorationBreak: "clone",
        transition: "background-color 160ms ease, opacity 160ms ease",
    },
    ".cm-diff-word-line-bg": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 10%, transparent)",
        boxShadow: "inset 3px 0 0 0 var(--diff-update)",
        transition: "background-color 160ms ease, box-shadow 160ms ease",
    },
    ".cm-diff-focused": {
        outline: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
        outlineOffset: "-1px",
    },
    ".cm-diff-word-removed": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 16%, transparent)",
        borderRadius: "3px",
        boxDecorationBreak: "clone",
        transition: "background-color 160ms ease, opacity 160ms ease",
    },
    ".cm-diff-pending": {
        animation: "cm-diff-pulse 1.5s ease-in-out infinite",
    },
    "@keyframes cm-diff-pulse": {
        "0%, 100%": {
            opacity: "1",
        },
        "50%": {
            opacity: "0.72",
        },
    },

    // ── Deleted text block (block widget via StateField) ──────────────
    ".cm-diff-deleted-block": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 10%, transparent)",
        borderLeft: "3px solid var(--diff-remove)",
        padding: "4px 8px 4px 10px",
        margin: "2px 0",
        borderRadius: "0 4px 4px 0",
        fontFamily: "inherit",
        fontSize: "inherit",
        lineHeight: "var(--text-input-line-height)",
        overflowAnchor: "none",
        transformOrigin: "top left",
        animation: "cm-diff-widget-enter 140ms ease-out",
        transition:
            "background-color 160ms ease, border-color 160ms ease, opacity 160ms ease, transform 160ms ease",
        willChange: "opacity, transform",
    },
    ".cm-diff-deleted-line": {
        color: "color-mix(in srgb, var(--diff-remove) 50%, var(--text-primary))",
        opacity: "0.75",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
    },
    ".cm-diff-deleted-block-focused": {
        boxShadow:
            "inset 3px 0 0 0 var(--diff-remove), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)",
    },
    ".cm-diff-deleted-summary": {
        color: "color-mix(in srgb, var(--diff-remove) 68%, var(--text-primary))",
        fontSize: "11px",
        fontWeight: "600",
        letterSpacing: "0.01em",
    },
    ".cm-diff-deleted-controls": {
        display: "flex",
        justifyContent: "flex-end",
        gap: "6px",
        paddingTop: "4px",
    },

    // ── Hunk controls (Keep / Reject buttons) ─────────────────────────
    ".cm-diff-hunk-controls": {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        marginLeft: "8px",
        verticalAlign: "text-top",
        position: "relative",
        zIndex: "1",
        opacity: "0.92",
        transform: "translateY(1px)",
        transition: "opacity 140ms ease, transform 140ms ease",
    },
    ".cm-line:hover .cm-diff-hunk-controls, .cm-diff-deleted-block:hover .cm-diff-deleted-controls":
        {
            opacity: "1",
            transform: "translateY(0)",
        },
    ".cm-diff-hunk-btn": {
        fontSize: "11px",
        fontFamily: "inherit",
        padding: "1px 10px",
        borderRadius: "4px",
        cursor: "pointer",
        border: "1px solid var(--border)",
        backgroundColor: "var(--bg-secondary)",
        color: "var(--text-secondary)",
        lineHeight: "20px",
        whiteSpace: "nowrap",
        userSelect: "none",
        transition:
            "background-color 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease",
    },
    ".cm-diff-hunk-btn:hover": {
        backgroundColor: "var(--bg-tertiary)",
        color: "var(--text-primary)",
    },
    ".cm-diff-hunk-btn-keep": {
        color: "var(--diff-add)",
        borderColor: "color-mix(in srgb, var(--diff-add) 40%, var(--border))",
    },
    ".cm-diff-hunk-btn-keep:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-add) 18%, var(--bg-secondary))",
        color: "var(--diff-add)",
    },
    ".cm-diff-hunk-btn-reject": {
        color: "var(--diff-remove)",
        borderColor:
            "color-mix(in srgb, var(--diff-remove) 40%, var(--border))",
    },
    ".cm-diff-hunk-btn-reject:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 18%, var(--bg-secondary))",
        color: "var(--diff-remove)",
    },
    "@keyframes cm-diff-widget-enter": {
        from: {
            opacity: "0",
            transform: "translateY(-4px) scaleY(0.98)",
        },
        to: {
            opacity: "1",
            transform: "translateY(0) scaleY(1)",
        },
    },
});
