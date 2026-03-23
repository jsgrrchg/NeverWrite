import { EditorView } from "@codemirror/view";

export const mergeViewTheme = EditorView.baseTheme({
    /* ── Inserted / changed lines (green gutter + tint) ────── */
    "&[data-merge-enabled='true'] .cm-changedLine, &[data-merge-enabled='true'] .cm-insertedLine":
        {
            backgroundColor:
                "color-mix(in srgb, var(--diff-add) 10%, transparent)",
            boxShadow: "inset 3px 0 0 0 var(--diff-add)",
            transition: "background-color 160ms ease, box-shadow 160ms ease",
        },

    /* ── Inline changed lines (blue gutter + tint) ─────────── */
    "&[data-merge-enabled='true'] .cm-inlineChangedLine": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 8%, transparent)",
        boxShadow: "inset 3px 0 0 0 var(--diff-update)",
    },

    /* ── Inline changed text highlight ─────────────────────── */
    "&[data-merge-enabled='true'] .cm-changedText": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 20%, transparent)",
        borderRadius: "2px",
        boxDecorationBreak: "clone",
    },

    /* ── Inline deleted text highlight ─────────────────────── */
    "&[data-merge-enabled='true'] .cm-deletedText": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 16%, transparent)",
        borderRadius: "2px",
        boxDecorationBreak: "clone",
        textDecoration: "line-through",
        textDecorationColor:
            "color-mix(in srgb, var(--diff-remove) 40%, transparent)",
    },

    /* ── Deleted chunk block ───────────────────────────────── */
    "&[data-merge-enabled='true'] .cm-deletedChunk": {
        position: "relative",
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 7%, transparent)",
        borderLeft: "3px solid var(--diff-remove)",
        padding: "6px 8px 6px 12px",
        margin: "1px 0",
        borderRadius: "0 4px 4px 0",
        borderTop:
            "1px solid color-mix(in srgb, var(--diff-remove) 12%, transparent)",
        borderBottom:
            "1px solid color-mix(in srgb, var(--diff-remove) 12%, transparent)",
        transition:
            "background-color 160ms ease, border-color 160ms ease, opacity 160ms ease",
    },

    /* ── Deleted line text ─────────────────────────────────── */
    "&[data-merge-enabled='true'] .cm-deletedLine": {
        color: "color-mix(in srgb, var(--diff-remove) 44%, var(--text-primary))",
        opacity: "0.72",
        fontStyle: "italic",
    },

    /* ── Pending state pulse animation ─────────────────────── */
    "&[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-changedLine, &[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-insertedLine, &[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-inlineChangedLine, &[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-deletedChunk":
        {
            animation: "cm-merge-pulse 1.5s ease-in-out infinite",
        },

    /* ── Chunk action buttons (inside deleted chunk) ───────── */
    "&[data-merge-enabled='true'] .cm-chunkButtons": {
        position: "absolute",
        top: "4px",
        right: "8px",
        display: "flex",
        gap: "4px",
        opacity: "0",
        transition: "opacity 120ms ease",
        zIndex: "1",
    },
    "&[data-merge-enabled='true'] .cm-deletedChunk:hover .cm-chunkButtons": {
        opacity: "1",
    },

    /* ── Merge action buttons ──────────────────────────────── */
    "&[data-merge-enabled='true'] .cm-merge-action": {
        fontSize: "11px",
        fontFamily: "inherit",
        padding: "2px 8px",
        borderRadius: "4px",
        cursor: "pointer",
        border: "1px solid transparent",
        backgroundColor: "transparent",
        color: "var(--text-secondary)",
        lineHeight: "18px",
        whiteSpace: "nowrap",
        userSelect: "none",
        fontWeight: "600",
        transition:
            "background-color 100ms ease, color 100ms ease, border-color 100ms ease",
    },
    "&[data-merge-enabled='true'] .cm-merge-action:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)",
        color: "var(--text-primary)",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-accept": {
        color: "var(--diff-add)",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-accept:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-add) 14%, var(--bg-primary))",
        borderColor: "color-mix(in srgb, var(--diff-add) 24%, transparent)",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-reject": {
        color: "var(--diff-remove)",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-reject:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 14%, var(--bg-primary))",
        borderColor: "color-mix(in srgb, var(--diff-remove) 24%, transparent)",
    },

    "@keyframes cm-merge-pulse": {
        "0%, 100%": { opacity: "1" },
        "50%": { opacity: "0.72" },
    },
});
