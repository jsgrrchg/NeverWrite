/**
 * CSS theme for inline diff decorations in the CodeMirror editor.
 *
 * Uses CSS variables from index.css (--diff-add, --diff-remove, --diff-update)
 * so colors automatically adapt to light/dark mode.
 *
 * Instead of relying on the gutter (which is hidden in live preview),
 * we use a left border on the line itself for the colored stripe.
 */

import { EditorView } from "@codemirror/view";

export const inlineDiffTheme = EditorView.baseTheme({
    // ── Added / modified line backgrounds with left border stripe ─────
    ".cm-diff-added": {
        backgroundColor: "color-mix(in srgb, var(--diff-add) 18%, transparent)",
        borderLeft: "3px solid var(--diff-add)",
        paddingLeft: "6px !important",
    },
    ".cm-diff-modified": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 18%, transparent)",
        borderLeft: "3px solid var(--diff-update)",
        paddingLeft: "6px !important",
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
    },
    ".cm-diff-deleted-line": {
        color: "color-mix(in srgb, var(--diff-remove) 50%, var(--text-primary))",
        opacity: "0.75",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
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
        float: "right",
        marginTop: "0px",
        marginRight: "4px",
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
        transition: "background-color 0.1s, color 0.1s",
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
});
