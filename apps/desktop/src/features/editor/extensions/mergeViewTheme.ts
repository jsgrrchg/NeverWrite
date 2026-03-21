import { EditorView } from "@codemirror/view";

export const mergeViewTheme = EditorView.baseTheme({
    "&[data-merge-enabled='true'] .cm-changedLine, &[data-merge-enabled='true'] .cm-insertedLine":
        {
            backgroundColor:
                "color-mix(in srgb, var(--diff-add) 14%, transparent)",
            boxShadow: "inset 3px 0 0 0 var(--diff-add)",
            transition: "background-color 160ms ease, box-shadow 160ms ease",
        },
    "&[data-merge-enabled='true'] .cm-inlineChangedLine": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 12%, transparent)",
        boxShadow: "inset 3px 0 0 0 var(--diff-update)",
    },
    "&[data-merge-enabled='true'] .cm-changedText": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-update) 18%, transparent)",
        borderRadius: "3px",
        boxDecorationBreak: "clone",
    },
    "&[data-merge-enabled='true'] .cm-deletedText": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 14%, transparent)",
        borderRadius: "3px",
        boxDecorationBreak: "clone",
    },
    "&[data-merge-enabled='true'] .cm-deletedChunk": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 10%, transparent)",
        borderLeft: "3px solid var(--diff-remove)",
        padding: "4px 8px 4px 10px",
        margin: "2px 0",
        borderRadius: "0 6px 6px 0",
        transition:
            "background-color 160ms ease, border-color 160ms ease, opacity 160ms ease",
    },
    "&[data-merge-enabled='true'] .cm-deletedLine": {
        color: "color-mix(in srgb, var(--diff-remove) 52%, var(--text-primary))",
        opacity: "0.78",
    },
    "&[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-changedLine, &[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-insertedLine, &[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-inlineChangedLine, &[data-merge-enabled='true'][data-merge-review-state='pending'] .cm-deletedChunk":
        {
            animation: "cm-merge-pulse 1.5s ease-in-out infinite",
        },
    "&[data-merge-enabled='true'] .cm-chunkButtons": {
        display: "flex",
        justifyContent: "flex-end",
        gap: "6px",
        paddingTop: "4px",
    },
    "&[data-merge-enabled='true'] .cm-merge-action": {
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
            "background-color 120ms ease, color 120ms ease, border-color 120ms ease",
    },
    "&[data-merge-enabled='true'] .cm-merge-action:hover": {
        backgroundColor: "var(--bg-tertiary)",
        color: "var(--text-primary)",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-accept": {
        color: "var(--diff-add)",
        borderColor: "color-mix(in srgb, var(--diff-add) 40%, var(--border))",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-accept:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-add) 18%, var(--bg-secondary))",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-reject": {
        color: "var(--diff-remove)",
        borderColor:
            "color-mix(in srgb, var(--diff-remove) 40%, var(--border))",
    },
    "&[data-merge-enabled='true'] .cm-merge-action-reject:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--diff-remove) 18%, var(--bg-secondary))",
    },
    "@keyframes cm-merge-pulse": {
        "0%, 100%": { opacity: "1" },
        "50%": { opacity: "0.72" },
    },
});
