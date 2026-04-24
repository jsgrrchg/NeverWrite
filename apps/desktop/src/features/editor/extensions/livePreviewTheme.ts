import { EditorView } from "@codemirror/view";

import {
    LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y,
    LIVE_PREVIEW_LIST_MARKER_GAP,
    LIVE_PREVIEW_LIST_MARKER_TOP,
    LIVE_PREVIEW_LIST_PADDING_Y,
    LIVE_PREVIEW_TASK_CHECKBOX_RADIUS,
    LIVE_PREVIEW_TASK_CHECKBOX_PARTIAL_OFFSET,
    LIVE_PREVIEW_TASK_CHECKBOX_SIZE,
    LIVE_PREVIEW_TASK_CHECKBOX_TICK_OFFSET,
    LIVE_PREVIEW_TASK_CHECKBOX_TOP,
    LIVE_PREVIEW_TASK_HIT_SLOP,
    LIVE_PREVIEW_TASK_MARKER_WIDTH,
    LIVE_PREVIEW_UNORDERED_MARKER_WIDTH,
} from "./livePreviewListMetrics";

export const livePreviewTheme = EditorView.baseTheme({
    ".cm-lp-hidden": {
        display: "inline-block",
        fontSize: "0",
        letterSpacing: "0",
        width: "0",
        overflow: "hidden",
        opacity: "0",
    },
    ".cm-lp-hidden-inline": {
        display: "inline-block",
        fontSize: "0",
        letterSpacing: "0",
        width: "0",
        overflow: "hidden",
        opacity: "0",
    },
    ".cm-lp-h1": {
        fontSize: "1.8em",
        fontWeight: "700",
        lineHeight: "1.3",
        textDecoration: "none",
    },
    ".cm-lp-h2": {
        fontSize: "1.5em",
        fontWeight: "600",
        lineHeight: "1.35",
        textDecoration: "none",
    },
    ".cm-lp-h3": {
        fontSize: "1.25em",
        fontWeight: "600",
        lineHeight: "1.4",
        textDecoration: "none",
    },
    ".cm-lp-h4": {
        fontSize: "1.1em",
        fontWeight: "600",
        lineHeight: "1.45",
        textDecoration: "none",
    },
    ".cm-lp-h5": {
        fontSize: "1.05em",
        fontWeight: "600",
        lineHeight: "1.5",
        textDecoration: "none",
    },
    ".cm-lp-h6": {
        fontSize: "1em",
        fontWeight: "600",
        lineHeight: "1.5",
        color: "var(--text-secondary)",
        textDecoration: "none",
    },
    ".cm-lp-h1, .cm-lp-h1 *": { textDecoration: "none" },
    ".cm-lp-h2, .cm-lp-h2 *": { textDecoration: "none" },
    ".cm-lp-h3, .cm-lp-h3 *": { textDecoration: "none" },
    ".cm-lp-h4, .cm-lp-h4 *": { textDecoration: "none" },
    ".cm-lp-h5, .cm-lp-h5 *": { textDecoration: "none" },
    ".cm-lp-h6, .cm-lp-h6 *": { textDecoration: "none" },
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
    ".cm-lp-link:focus-visible, .cm-lp-footnote-ref:focus-visible, .cm-inline-image-link:focus-visible, .cm-youtube-link:focus-visible, .cm-note-embed:focus-visible, .cm-lp-table-link:focus-visible":
        {
            outline: "2px solid color-mix(in srgb, var(--accent) 55%, white)",
            outlineOffset: "2px",
            borderRadius: "8px",
        },
    ".cm-lp-subscript": {
        fontSize: "0.8em",
        verticalAlign: "sub",
    },
    ".cm-lp-superscript": {
        fontSize: "0.8em",
        verticalAlign: "super",
    },
    ".cm-lp-kbd": {
        fontFamily:
            "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace",
        fontSize: "0.82em",
        border: "1px solid var(--border)",
        borderBottomWidth: "2px",
        borderRadius: "6px",
        padding: "0 0.38em",
        background:
            "color-mix(in srgb, var(--bg-secondary) 82%, var(--bg-primary))",
        boxShadow: "0 1px 0 color-mix(in srgb, var(--border) 70%, transparent)",
    },
    ".cm-lp-math-inline": {
        fontFamily: "'Times New Roman', Georgia, 'Nimbus Roman No9 L', serif",
        fontStyle: "italic",
        background:
            "color-mix(in srgb, var(--bg-secondary) 78%, var(--bg-primary))",
        borderRadius: "5px",
        padding: "0 0.28em",
    },
    ".cm-lp-math-block-line": {
        display: "block",
        margin: "8px 0",
        padding: "10px 14px",
        borderRadius: "10px",
        background:
            "color-mix(in srgb, var(--bg-secondary) 82%, var(--bg-primary))",
        border: "1px solid var(--border)",
    },
    ".cm-lp-math-block": {
        fontFamily: "'Times New Roman', Georgia, 'Nimbus Roman No9 L', serif",
        fontStyle: "italic",
    },
    ".cm-lp-blockquote": {
        color: "var(--text-secondary)",
    },
    ".cm-lp-blockquote-line": {
        borderLeft: "3px solid var(--accent)",
        paddingLeft: "12px",
    },
    ".cm-lp-blockquote-level-2": {
        paddingLeft: "28px !important",
        position: "relative",
    },
    ".cm-lp-blockquote-level-2::before": {
        content: '""',
        position: "absolute",
        left: "14px",
        top: "0",
        bottom: "0",
        width: "3px",
        background: "color-mix(in srgb, var(--accent) 55%, var(--border))",
        pointerEvents: "none",
    },
    ".cm-lp-blockquote-level-3": {
        paddingLeft: "44px !important",
        position: "relative",
    },
    ".cm-lp-blockquote-level-3::after": {
        content: '""',
        position: "absolute",
        left: "30px",
        top: "0",
        bottom: "0",
        width: "3px",
        background: "color-mix(in srgb, var(--accent) 35%, var(--border))",
        pointerEvents: "none",
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
        "--cm-lp-marker-gap": LIVE_PREVIEW_LIST_MARKER_GAP,
        "--cm-lp-nesting-offset": "0em",
        paddingLeft: `calc(var(--cm-lp-indent, 0ch) + var(--cm-lp-nesting-offset) + var(--cm-lp-marker-width, ${LIVE_PREVIEW_UNORDERED_MARKER_WIDTH}) + var(--cm-lp-marker-gap)) !important`,
        lineHeight: "inherit",
        paddingTop: `var(--cm-lp-list-padding-y, ${LIVE_PREVIEW_LIST_PADDING_Y})`,
        paddingBottom: `var(--cm-lp-list-padding-y, ${LIVE_PREVIEW_LIST_PADDING_Y})`,
    },
    ".cm-lp-task-line": {
        cursor: "text",
        "--cm-lp-task-checkbox-size": LIVE_PREVIEW_TASK_CHECKBOX_SIZE,
        "--cm-lp-task-hit-slop": LIVE_PREVIEW_TASK_HIT_SLOP,
        color: "var(--text-primary)",
        transition: "color 120ms ease",
    },
    ".cm-lp-task-line:focus-visible": {
        outline: "none",
    },
    ".cm-lp-list-continuation": {
        paddingLeft: `calc(var(--cm-lp-indent, 0ch) + var(--cm-lp-nesting-offset, 0em) + var(--cm-lp-marker-width, ${LIVE_PREVIEW_UNORDERED_MARKER_WIDTH}) + var(--cm-lp-marker-gap, ${LIVE_PREVIEW_LIST_MARKER_GAP})) !important`,
        lineHeight: "inherit",
        paddingTop: `var(--cm-lp-list-continuation-padding-y, ${LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y})`,
        paddingBottom: `var(--cm-lp-list-continuation-padding-y, ${LIVE_PREVIEW_LIST_CONTINUATION_PADDING_Y})`,
    },
    ".cm-lp-li-line::before": {
        position: "absolute",
        left: "calc(var(--cm-lp-indent, 0ch) + var(--cm-lp-nesting-offset))",
        top: LIVE_PREVIEW_LIST_MARKER_TOP,
        content: "attr(data-lp-marker)",
        color: "var(--text-secondary)",
        width: `var(--cm-lp-marker-width, ${LIVE_PREVIEW_UNORDERED_MARKER_WIDTH})`,
        fontSize: "1em",
        textAlign: "right",
        pointerEvents: "none",
        lineHeight: "1",
        display: "inline-block",
        transform: "scale(var(--cm-lp-marker-scale, 1))",
        transformOrigin: "right center",
        opacity: "var(--cm-lp-marker-opacity, 0.88)",
    },
    ".cm-lp-li-unordered::before": {
        fontWeight: "500",
    },
    ".cm-lp-li-ordered::before": {
        content: "attr(data-lp-marker)",
        fontVariantNumeric: "tabular-nums",
        fontWeight: "600",
    },
    ".cm-lp-task-line::before": {
        position: "absolute",
        content: '""',
        width: LIVE_PREVIEW_TASK_CHECKBOX_SIZE,
        height: LIVE_PREVIEW_TASK_CHECKBOX_SIZE,
        left: `calc(var(--cm-lp-indent, 0ch) + var(--cm-lp-nesting-offset) + ((var(--cm-lp-marker-width, ${LIVE_PREVIEW_TASK_MARKER_WIDTH}) - ${LIVE_PREVIEW_TASK_CHECKBOX_SIZE}) / 2))`,
        top: LIVE_PREVIEW_TASK_CHECKBOX_TOP,
        borderRadius: LIVE_PREVIEW_TASK_CHECKBOX_RADIUS,
        border: "1.5px solid color-mix(in srgb, var(--text-secondary) 34%, var(--border))",
        background:
            "color-mix(in srgb, var(--bg-primary) 92%, var(--bg-secondary))",
        boxSizing: "border-box",
        pointerEvents: "none",
        opacity: "var(--cm-lp-marker-opacity, 1)",
        transition:
            "border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease, transform 120ms ease",
    },
    ".cm-lp-task-line::after": {
        content: '""',
        position: "absolute",
        left: `calc(var(--cm-lp-indent, 0ch) + var(--cm-lp-nesting-offset) + ((var(--cm-lp-marker-width, ${LIVE_PREVIEW_TASK_MARKER_WIDTH}) - ${LIVE_PREVIEW_TASK_CHECKBOX_SIZE}) / 2) + 0.29em)`,
        top: `calc(${LIVE_PREVIEW_TASK_CHECKBOX_TOP} + ${LIVE_PREVIEW_TASK_CHECKBOX_TICK_OFFSET})`,
        width: "0.31em",
        height: "0.17em",
        borderLeft: "2px solid transparent",
        borderBottom: "2px solid transparent",
        transform: "rotate(-45deg)",
        pointerEvents: "none",
        opacity: 0,
        transition: "opacity 120ms ease, border-color 120ms ease",
    },
    ".cm-lp-task-line:focus-visible::before": {
        borderColor: "color-mix(in srgb, var(--accent) 52%, var(--border))",
        boxShadow:
            "0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent)",
    },
    ".cm-lp-task-line.cm-lp-task-toggle-hover": {
        cursor: "pointer",
    },
    ".cm-lp-task-line.cm-lp-task-toggle-hover::before": {
        borderColor: "color-mix(in srgb, var(--accent) 42%, var(--border))",
        boxShadow:
            "0 0 0 2px color-mix(in srgb, var(--accent) 10%, transparent)",
        transform: "scale(1.03)",
    },
    '.cm-lp-task-line[data-lp-task-state="open"]::before': {
        background:
            "color-mix(in srgb, var(--bg-primary) 90%, var(--bg-secondary))",
    },
    '.cm-lp-task-checked, .cm-lp-task-line[data-lp-task-state="done"]': {
        color: "color-mix(in srgb, var(--text-secondary) 88%, var(--text-primary))",
    },
    '.cm-lp-task-checked::before, .cm-lp-task-line[data-lp-task-state="done"]::before':
        {
            borderColor: "color-mix(in srgb, var(--accent) 52%, var(--border))",
            background:
                "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
        },
    '.cm-lp-task-checked::after, .cm-lp-task-line[data-lp-task-state="done"]::after':
        {
            borderLeftColor: "var(--accent)",
            borderBottomColor: "var(--accent)",
            opacity: 1,
        },
    '.cm-lp-task-partial, .cm-lp-task-line[data-lp-task-state="partial"]': {
        color: "color-mix(in srgb, var(--text-secondary) 82%, var(--text-primary))",
    },
    '.cm-lp-task-partial::before, .cm-lp-task-line[data-lp-task-state="partial"]::before':
        {
            borderColor: "color-mix(in srgb, var(--accent) 44%, var(--border))",
            background:
                "color-mix(in srgb, var(--accent) 9%, var(--bg-primary))",
        },
    '.cm-lp-task-partial::after, .cm-lp-task-line[data-lp-task-state="partial"]::after':
        {
            left: `calc(var(--cm-lp-indent, 0ch) + var(--cm-lp-nesting-offset) + ((var(--cm-lp-marker-width, ${LIVE_PREVIEW_TASK_MARKER_WIDTH}) - ${LIVE_PREVIEW_TASK_CHECKBOX_SIZE}) / 2) + 0.19em)`,
            top: `calc(${LIVE_PREVIEW_TASK_CHECKBOX_TOP} + ${LIVE_PREVIEW_TASK_CHECKBOX_PARTIAL_OFFSET})`,
            width: "0.46em",
            height: "0",
            borderLeft: "none",
            borderBottom: "2px solid var(--accent)",
            transform: "none",
            opacity: 1,
        },
    ".cm-lp-task-line::selection, .cm-lp-task-line *::selection": {
        backgroundColor: "var(--selection-bg)",
    },
    ".cm-lp-footnote-ref": {
        fontSize: "0.72em",
        verticalAlign: "super",
        color: "var(--accent)",
        cursor: "pointer",
        fontWeight: "600",
        marginLeft: "0.08em",
    },
    ".cm-lp-footnote-def": {
        color: "var(--text-secondary)",
        paddingLeft: "18px",
        borderLeft:
            "2px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
        marginLeft: "4px",
    },
    ".cm-lp-callout": {
        borderLeft:
            "3px solid color-mix(in srgb, var(--accent) 42%, var(--border))",
        background:
            "color-mix(in srgb, var(--bg-secondary) 70%, var(--bg-primary))",
        paddingLeft: "14px",
        margin: "6px 0",
    },
    ".cm-lp-callout-head": {
        fontWeight: "700",
        color: "var(--text-primary)",
    },
    ".cm-lp-callout-head::before": {
        marginRight: "6px",
        fontSize: "1.1em",
        verticalAlign: "middle",
    },
    ".cm-lp-callout-note": {
        borderLeftColor: "color-mix(in srgb, #3b82f6 55%, var(--border))",
    },
    ".cm-lp-callout-note .cm-lp-callout-head::before": {
        content: '"ℹ"',
        color: "#3b82f6",
    },
    ".cm-lp-callout-tip": {
        borderLeftColor: "color-mix(in srgb, #10b981 55%, var(--border))",
    },
    ".cm-lp-callout-tip .cm-lp-callout-head::before": {
        content: '"💡"',
        color: "#10b981",
    },
    ".cm-lp-callout-warning": {
        borderLeftColor: "color-mix(in srgb, #f59e0b 55%, var(--border))",
    },
    ".cm-lp-callout-warning .cm-lp-callout-head::before": {
        content: '"⚠"',
        color: "#f59e0b",
    },
    ".cm-lp-callout-danger": {
        borderLeftColor: "color-mix(in srgb, #ef4444 55%, var(--border))",
    },
    ".cm-lp-callout-danger .cm-lp-callout-head::before": {
        content: '"🚨"',
        color: "#ef4444",
    },
    ".cm-lp-callout-success": {
        borderLeftColor: "color-mix(in srgb, #10b981 55%, var(--border))",
    },
    ".cm-lp-callout-success .cm-lp-callout-head::before": {
        content: '"✅"',
        color: "#10b981",
    },
    ".cm-lp-callout-question": {
        borderLeftColor: "color-mix(in srgb, #f59e0b 55%, var(--border))",
    },
    ".cm-lp-callout-question .cm-lp-callout-head::before": {
        content: '"❓"',
        color: "#f59e0b",
    },
    ".cm-lp-callout-bug": {
        borderLeftColor: "color-mix(in srgb, #ef4444 55%, var(--border))",
    },
    ".cm-lp-callout-bug .cm-lp-callout-head::before": {
        content: '"🐛"',
        color: "#ef4444",
    },
    ".cm-lp-callout-example": {
        borderLeftColor: "color-mix(in srgb, #8b5cf6 55%, var(--border))",
    },
    ".cm-lp-callout-example .cm-lp-callout-head::before": {
        content: '"📝"',
        color: "#8b5cf6",
    },
    ".cm-lp-callout-quote": {
        borderLeftColor:
            "color-mix(in srgb, var(--text-secondary) 55%, var(--border))",
    },
    ".cm-lp-callout-quote .cm-lp-callout-head::before": {
        content: '"💬"',
        color: "var(--text-secondary)",
    },
    ".cm-lp-callout-abstract": {
        borderLeftColor: "color-mix(in srgb, #06b6d4 55%, var(--border))",
    },
    ".cm-lp-callout-abstract .cm-lp-callout-head::before": {
        content: '"📋"',
        color: "#06b6d4",
    },
    ".cm-lp-callout-todo": {
        borderLeftColor: "color-mix(in srgb, #3b82f6 55%, var(--border))",
    },
    ".cm-lp-callout-todo .cm-lp-callout-head::before": {
        content: '"☑"',
        color: "#3b82f6",
    },
    ".cm-lp-callout-collapsible": {
        cursor: "pointer",
    },
    ".cm-lp-callout-collapsible::after": {
        content: '"▾"',
        position: "absolute",
        right: "8px",
        color: "var(--text-secondary)",
        fontSize: "0.85em",
        transition: "transform 120ms ease",
    },
    '.cm-lp-callout-collapsible[data-callout-collapsed="true"]::after': {
        content: '"▸"',
    },
    ".cm-inline-image-wrapper": {
        display: "flex",
        justifyContent: "center",
        padding: "8px 0",
        position: "relative",
    },
    ".cm-inline-image-content": {
        display: "inline-flex",
        maxWidth: "100%",
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
    ".cm-image-size-toolbar": {
        position: "absolute",
        top: "16px",
        right: "8px",
        display: "none",
        gap: "2px",
        padding: "3px",
        borderRadius: "6px",
        background: "color-mix(in srgb, var(--bg-elevated) 90%, transparent)",
        backdropFilter: "blur(8px)",
        border: "1px solid var(--border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
        zIndex: "10",
    },
    ".cm-inline-image-wrapper:hover .cm-image-size-toolbar": {
        display: "flex",
    },
    ".cm-image-size-btn": {
        padding: "2px 8px",
        fontSize: "11px",
        fontWeight: "600",
        borderRadius: "4px",
        border: "none",
        cursor: "pointer",
        color: "var(--text-secondary)",
        background: "transparent",
        lineHeight: "1.4",
    },
    ".cm-image-size-btn:hover": {
        background: "var(--bg-tertiary)",
        color: "var(--text-primary)",
    },
    ".cm-image-size-btn-active": {
        background: "var(--accent) !important",
        color: "white !important",
    },
    ".cm-pdf-embed-wrapper": {
        display: "flex",
        justifyContent: "center",
        padding: "4px 0",
    },
    ".cm-pdf-embed-chip": {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 12px",
        borderRadius: "6px",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        cursor: "pointer",
        fontSize: "13px",
        color: "var(--text-primary)",
        transition: "background 0.15s",
    },
    ".cm-pdf-embed-chip:hover": {
        background: "var(--bg-tertiary)",
    },
    ".cm-pdf-embed-icon": {
        width: "16px",
        height: "16px",
        flexShrink: "0",
        color: "var(--text-secondary)",
    },
    ".cm-pdf-embed-name": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    ".cm-youtube-link-wrapper": {
        padding: "8px 0",
        display: "flex",
        justifyContent: "center",
    },
    ".cm-youtube-link": {
        display: "block",
        maxWidth: "420px",
        borderRadius: "10px",
        border: "1px solid var(--border)",
        background:
            "color-mix(in srgb, var(--bg-secondary) 76%, var(--bg-primary))",
        cursor: "pointer",
        overflow: "hidden",
    },
    ".cm-youtube-link-media": {
        position: "relative",
        aspectRatio: "16 / 9",
        background:
            "linear-gradient(135deg, color-mix(in srgb, var(--bg-tertiary) 90%, black), color-mix(in srgb, var(--bg-secondary) 88%, black))",
    },
    '.cm-youtube-link-media[data-no-thumbnail="true"]': {
        minHeight: "120px",
    },
    ".cm-youtube-link-thumbnail": {
        display: "block",
        width: "100%",
        height: "100%",
        objectFit: "cover",
    },
    ".cm-youtube-link-body": {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "10px 12px 12px",
        justifyContent: "center",
    },
    ".cm-youtube-link-play": {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: "52px",
        height: "36px",
        borderRadius: "12px",
        transform: "translate(-50%, -50%)",
        background: "rgb(255 0 0 / 0.92)",
        boxShadow: "0 12px 32px rgb(0 0 0 / 0.28)",
    },
    ".cm-youtube-link-play::before": {
        content: '""',
        position: "absolute",
        left: "22px",
        top: "11px",
        borderTop: "7px solid transparent",
        borderBottom: "7px solid transparent",
        borderLeft: "12px solid white",
    },
    ".cm-youtube-link-label": {
        color: "var(--text-primary)",
        fontSize: "0.85em",
        fontWeight: "700",
        lineHeight: "1.3",
    },
    ".cm-youtube-link-meta": {
        color: "var(--text-secondary)",
        fontSize: "0.72em",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
    },
    ".cm-note-embed-wrapper": {
        padding: "12px 0",
    },
    ".cm-note-embed": {
        display: "block",
        padding: "14px 16px",
        borderRadius: "12px",
        border: "1px solid var(--border)",
        background:
            "color-mix(in srgb, var(--bg-secondary) 76%, var(--bg-primary))",
        cursor: "pointer",
    },
    ".cm-note-embed-title": {
        fontWeight: "700",
        color: "var(--text-primary)",
        marginBottom: "4px",
    },
    ".cm-note-embed-meta": {
        color: "var(--text-secondary)",
        fontSize: "0.82em",
    },
    ".cm-note-embed-preview": {
        fontSize: "0.88em",
        color: "var(--text-secondary)",
        lineHeight: "1.5",
        marginTop: "4px",
    },
    ".cm-note-embed-preview > div": {
        marginBottom: "2px",
    },
    ".cm-note-embed-h1, .cm-note-embed-h2, .cm-note-embed-h3, .cm-note-embed-h4, .cm-note-embed-h5, .cm-note-embed-h6":
        {
            fontWeight: "600",
            color: "var(--text-primary)",
        },
    ".cm-note-embed-h1": { fontSize: "1.15em" },
    ".cm-note-embed-h2": { fontSize: "1.08em" },
    ".cm-note-embed-li": {
        paddingLeft: "1.2em",
        position: "relative",
    },
    ".cm-note-embed-li::before": {
        content: '"\\2022"',
        position: "absolute",
        left: "0.3em",
        color: "var(--text-secondary)",
    },
    ".cm-note-embed-preview code": {
        fontSize: "0.9em",
        padding: "1px 4px",
        borderRadius: "3px",
        background:
            "color-mix(in srgb, var(--bg-tertiary) 60%, var(--bg-primary))",
    },
    ".cm-note-embed-wikilink": {
        color: "var(--accent)",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: "2px",
    },
    ".cm-lp-table-widget": {
        display: "block",
        padding: "12px 0",
        overflowX: "auto",
        cursor: "text",
    },
    ".cm-lp-table": {
        width: "100%",
        fontSize: "0.95em",
        background: "var(--bg-primary)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        overflow: "hidden",
    },
    ".cm-lp-table-row": {
        display: "grid",
        gridTemplateColumns:
            "repeat(var(--cm-lp-table-columns, 1), minmax(0, 1fr))",
    },
    ".cm-lp-table-cell": {
        padding: "10px 12px",
        borderBottom: "1px solid var(--border)",
        borderRight: "1px solid var(--border)",
        verticalAlign: "top",
        textAlign: "left",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
    },
    ".cm-lp-table-row .cm-lp-table-cell:last-child": {
        borderRight: "none",
    },
    ".cm-lp-table-row:last-child .cm-lp-table-cell": {
        borderBottom: "none",
    },
    ".cm-lp-table-row-header .cm-lp-table-cell": {
        fontWeight: "700",
        color: "var(--text-primary)",
        background:
            "color-mix(in srgb, var(--bg-secondary) 82%, var(--bg-primary))",
    },
    ".cm-lp-table-row:not(.cm-lp-table-row-header) .cm-lp-table-cell": {
        color: "var(--text-primary)",
        background: "var(--bg-primary)",
    },
    ".cm-lp-table-row:not(.cm-lp-table-row-header):hover .cm-lp-table-cell": {
        background:
            "color-mix(in srgb, var(--bg-secondary) 76%, var(--bg-primary))",
    },
    ".cm-lp-table-cell[data-align='center']": {
        textAlign: "center",
    },
    ".cm-lp-table-cell[data-align='right']": {
        textAlign: "right",
    },
    ".cm-lp-table-link": {
        cursor: "pointer",
        textDecoration: "underline",
        textUnderlineOffset: "3px",
    },
    ".cm-lp-table-url": {
        color: "var(--accent)",
        textDecorationStyle: "solid",
    },
    ".cm-lp-table-wikilink-valid": {
        color: "var(--accent)",
        textDecorationStyle: "dotted",
    },
    ".cm-lp-table-wikilink-broken": {
        color: "#ef4444",
        textDecorationColor: "#ef4444",
        textDecorationStyle: "dotted",
    },
    ".cm-lp-table-bold": {
        fontWeight: "700",
    },
    ".cm-lp-table-highlight": {
        backgroundColor: "var(--highlight-bg)",
        color: "var(--highlight-text)",
        borderRadius: "3px",
        padding: "0 2px",
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
    },
    ".cm-katex-inline": {
        verticalAlign: "middle",
    },
    ".cm-katex-block": {
        display: "flex",
        justifyContent: "center",
        padding: "20px 0",
    },
    ".cm-katex-error": {
        color: "#ef4444",
        fontStyle: "italic",
        fontSize: "0.9em",
    },
    ".cm-code-block-fence-hidden": {
        height: "0",
        padding: "0 !important",
        margin: "0",
        lineHeight: "0",
        fontSize: "0",
        overflow: "hidden",
    },
    ".cm-code-block-header-shell": {
        paddingTop: "8px",
    },
    ".cm-code-block-header": {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "6px 12px",
        background:
            "color-mix(in srgb, var(--bg-tertiary) 80%, var(--bg-secondary))",
        borderRadius: "8px 8px 0 0",
        border: "1px solid var(--border)",
        borderBottom: "none",
        fontSize: "0.78em",
        color: "var(--text-secondary)",
    },
    ".cm-code-block-header-only": {
        borderBottom: "1px solid var(--border)",
        borderRadius: "8px",
    },
    ".cm-code-block-lang": {
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
    },
    ".cm-code-block-copy": {
        background: "none",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        padding: "2px 8px",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontSize: "0.9em",
    },
    ".cm-code-block-copy:hover": {
        background:
            "color-mix(in srgb, var(--bg-secondary) 60%, var(--bg-tertiary))",
    },
    ".cm-code-block-line": {
        background:
            "color-mix(in srgb, var(--bg-tertiary) 50%, var(--bg-primary)) !important",
        borderLeft: "1px solid var(--border)",
        borderRight: "1px solid var(--border)",
        paddingLeft: "12px !important",
    },
    ".cm-code-block-line-first": {
        borderTop: "1px solid var(--border)",
        borderRadius: "8px 8px 0 0",
        paddingTop: "8px !important",
    },
    ".cm-code-block-line-last": {
        borderBottom: "1px solid var(--border)",
        borderRadius: "0 0 8px 8px",
        paddingBottom: "8px !important",
    },
    ".cm-link-tooltip": {
        position: "fixed",
        zIndex: "1000",
        padding: "5px 10px",
        borderRadius: "6px",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        color: "var(--text-secondary)",
        fontSize: "0.82em",
        maxWidth: "320px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        boxShadow: "0 4px 12px rgb(0 0 0 / 0.12)",
        pointerEvents: "none",
        animation: "cm-tooltip-fade-in 100ms ease",
    },
    ".cm-link-tooltip-footnote": {
        maxWidth: "400px",
        whiteSpace: "normal",
        lineHeight: "1.5",
    },
    "@keyframes cm-tooltip-fade-in": {
        from: { opacity: "0", transform: "translateY(-2px)" },
        to: { opacity: "1", transform: "translateY(0)" },
    },
    ".cm-lp-table-fallback": {
        margin: 0,
        padding: "12px 14px",
        borderRadius: "10px",
        border: "1px dashed var(--border)",
        background:
            "color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-primary))",
        color: "var(--text-secondary)",
        whiteSpace: "pre-wrap",
        fontFamily:
            "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace",
        fontSize: "0.9em",
    },
});
