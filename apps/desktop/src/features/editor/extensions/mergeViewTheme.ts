import { EditorView } from "@codemirror/view";

export const mergeViewTheme = EditorView.baseTheme({
    /* Keep the line-level signal subtle so the exact changed text remains primary. */
    /* ── Inserted / changed lines (green gutter + faint tint) ─ */
    "&[data-merge-enabled='true'] .cm-changedLine, &[data-merge-enabled='true'] .cm-insertedLine":
        {
            backgroundColor:
                "color-mix(in srgb, var(--diff-add) 3%, transparent)",
            boxShadow:
                "inset 1px 0 0 0 color-mix(in srgb, var(--diff-add) 72%, transparent)",
            transition: "background-color 160ms ease, box-shadow 160ms ease",
        },

    /* ── Inline changed lines (even fainter than whole-line inserts) ─ */
    "&[data-merge-enabled='true'] .cm-inlineChangedLine": {
        backgroundColor: "color-mix(in srgb, var(--diff-add) 2%, transparent)",
        boxShadow:
            "inset 1px 0 0 0 color-mix(in srgb, var(--diff-add) 56%, transparent)",
    },

    /* ── Inline changed text highlight (primary signal) ───── */
    "&[data-merge-enabled='true'] .cm-changedText": {
        background: "none",
        backgroundColor: "color-mix(in srgb, var(--diff-add) 18%, transparent)",
        borderRadius: "2px",
        boxDecorationBreak: "clone",
    },
    /* Pure insertions already read as "all-new" via line/chunk context,
       so suppress the inner marker only for those semantically pure ranges. */
    "&[data-merge-enabled='true'] .cm-pure-insertion-content .cm-changedText, &[data-merge-enabled='true'] .cm-pure-insertion-content.cm-changedText":
        {
            backgroundColor: "transparent",
        },

    /* Deleted text should stay readable without overpowering changed text. */
    /* ── Inline deleted text highlight ─────────────────────── */
    "&[data-merge-enabled='true'] .cm-deletedText": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 6%, transparent)",
        borderRadius: "2px",
        boxDecorationBreak: "clone",
    },
    /* Pure deletion blocks already have their own red container treatment. */
    "&[data-merge-enabled='true'] .cm-pure-deletion-chunk .cm-deletedText": {
        backgroundColor: "transparent",
    },

    /* ── Deleted chunk block ───────────────────────────────── */
    "&[data-merge-enabled='true'] .cm-deletedChunk": {
        position: "relative",
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 7%, transparent)",
        borderLeft: "1.5px solid var(--diff-remove)",
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
    /* Pure insertions still get an empty deleted-chunk placeholder from the
       merge widget. Hide that shell so it doesn't read as a real deletion. */
    "&[data-merge-enabled='true'] .cm-deletedChunk:empty": {
        backgroundColor: "transparent",
        borderLeft: "none",
        borderTop: "none",
        borderBottom: "none",
        padding: "0",
        margin: "0",
        borderRadius: "0",
        minHeight: "0",
        height: "0",
        overflow: "hidden",
    },

    /* ── Deleted line text ─────────────────────────────────── */
    "&[data-merge-enabled='true'] .cm-deletedLine": {
        color: "color-mix(in srgb, var(--diff-remove) 44%, var(--text-primary))",
        opacity: "0.72",
        fontStyle: "italic",
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
});
