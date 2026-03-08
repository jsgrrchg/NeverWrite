import { EditorView } from "@codemirror/view";

export const livePreviewTheme = EditorView.baseTheme({
    ".cm-lp-hidden": {
        display: "none",
    },
    ".cm-lp-hidden-inline": {
        opacity: "0",
        pointerEvents: "none",
    },
    ".cm-lp-h1": { fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3", textDecoration: "none" },
    ".cm-lp-h2": { fontSize: "1.5em", fontWeight: "600", lineHeight: "1.35", textDecoration: "none" },
    ".cm-lp-h3": { fontSize: "1.25em", fontWeight: "600", lineHeight: "1.4", textDecoration: "none" },
    ".cm-lp-h4": { fontSize: "1.1em", fontWeight: "600", lineHeight: "1.45", textDecoration: "none" },
    ".cm-lp-h5": { fontSize: "1.05em", fontWeight: "600", lineHeight: "1.5", textDecoration: "none" },
    ".cm-lp-h6": {
        fontSize: "1em",
        fontWeight: "600",
        lineHeight: "1.5",
        color: "var(--text-secondary)",
        textDecoration: "none",
    },
    ".cm-lp-bold": { fontWeight: "700" },
    ".cm-lp-italic": { fontStyle: "italic" },
    ".cm-lp-code": {
        fontFamily:
            "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace",
        fontSize: "0.9em",
        backgroundColor: "var(--bg-tertiary)",
        borderRadius: "3px",
        padding: "1px 4px",
    },
    ".cm-lp-strikethrough": { textDecoration: "line-through" },
    ".cm-lp-highlight": {
        backgroundColor: "var(--highlight-bg)",
        color: "var(--highlight-text)",
        borderRadius: "3px",
        padding: "0 2px",
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
    },
    ".cm-lp-link": {
        color: "var(--accent)",
        textDecoration: "underline",
        textDecorationStyle: "solid",
        textUnderlineOffset: "3px",
        cursor: "pointer",
    },
    ".cm-lp-blockquote": {
        color: "var(--text-secondary)",
    },
    ".cm-lp-blockquote-line": {
        borderLeft: "3px solid var(--accent)",
        paddingLeft: "12px",
    },
    ".cm-lp-blockquote-line[data-lp-editing-marker='true']": {
        borderLeft: "3px solid var(--accent)",
        paddingLeft: "12px",
    },
    ".cm-lp-hr-line": {
        position: "relative",
        minHeight: "1.2em",
    },
    ".cm-lp-hr-line::before": {
        content: '""',
        position: "absolute",
        left: 0,
        right: 0,
        top: "50%",
        borderTop: "1px solid var(--border)",
        transform: "translateY(-50%)",
    },
    ".cm-lp-li-line, .cm-lp-task-line": {
        position: "relative",
        paddingLeft: "calc(var(--cm-lp-indent, 0ch) + 2.1em) !important",
    },
    ".cm-lp-li-line::before": {
        position: "absolute",
        left: "calc(var(--cm-lp-indent, 0ch) + 0.1em)",
        top: "0.02em",
        content: '"•"',
        color: "var(--text-secondary)",
        width: "1.45em",
        textAlign: "right",
        pointerEvents: "none",
        lineHeight: "inherit",
    },
    ".cm-lp-li-unordered::before": {
        content: '"•"',
        fontSize: "0.95em",
    },
    ".cm-lp-li-line[data-lp-editing-marker='true']::before, .cm-lp-li-ordered[data-lp-editing-marker='true']::before, .cm-lp-li-unordered[data-lp-editing-marker='true']::before": {
        opacity: 0,
    },
    ".cm-lp-li-ordered::before": {
        content: "attr(data-lp-marker)",
        fontVariantNumeric: "tabular-nums",
        fontWeight: "600",
    },
    ".cm-lp-task-line::before": {
        position: "absolute",
        content: '""',
        width: "0.92em",
        height: "0.92em",
        left: "calc(var(--cm-lp-indent, 0ch) + 0.35em)",
        top: "0.3em",
        borderRadius: "0.22em",
        border: "1.5px solid color-mix(in srgb, var(--text-secondary) 40%, var(--border))",
        background:
            "color-mix(in srgb, var(--bg-primary) 96%, var(--bg-secondary))",
        boxSizing: "border-box",
        pointerEvents: "none",
    },
    ".cm-lp-task-line::after": {
        content: '""',
        position: "absolute",
        left: "calc(var(--cm-lp-indent, 0ch) + 0.64em)",
        top: "0.56em",
        width: "0.31em",
        height: "0.17em",
        borderLeft: "2px solid transparent",
        borderBottom: "2px solid transparent",
        transform: "rotate(-45deg)",
        pointerEvents: "none",
        opacity: 0,
    },
    ".cm-lp-task-checked": {
        color: "var(--text-secondary)",
    },
    ".cm-lp-task-checked::before": {
        borderColor: "color-mix(in srgb, var(--accent) 55%, var(--border))",
        background: "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
    },
    ".cm-lp-task-checked::after": {
        borderLeftColor: "var(--accent)",
        borderBottomColor: "var(--accent)",
        opacity: 1,
    },
    ".cm-lp-task-line[data-lp-editing-marker='true']::before, .cm-lp-task-line[data-lp-editing-marker='true']::after": {
        opacity: 0,
    },
    ".cm-inline-image-wrapper": {
        display: "flex",
        justifyContent: "center",
        padding: "8px 0",
    },
    ".cm-inline-image-link": {
        cursor: "pointer",
    },
    ".cm-inline-image": {
        maxWidth: "100%",
        maxHeight: "500px",
        borderRadius: "6px",
        objectFit: "contain",
    },
    ".cm-inline-image-fallback": {
        color: "var(--text-secondary)",
        fontSize: "0.85em",
        fontStyle: "italic",
        padding: "8px 12px",
        border: "1px dashed var(--border)",
        borderRadius: "6px",
    },
});
