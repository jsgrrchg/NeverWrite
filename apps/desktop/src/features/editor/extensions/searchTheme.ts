import { EditorView } from "@codemirror/view";

export const searchTheme = EditorView.theme({
    // Floating panel container
    ".cm-panels": {
        display: "flex",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: "6px 12px 0",
    },
    ".cm-panels-top": {
        borderBottom: "none",
    },

    ".cm-search": {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        width: "min(100%, 720px)",
        padding: "5px 6px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
        flexWrap: "wrap",
    },

    ".cm-textfield": {
        backgroundColor:
            "color-mix(in srgb, var(--bg-secondary) 60%, var(--bg-primary))",
        color: "var(--text-primary)",
        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        borderRadius: "6px",
        padding: "0 8px",
        fontSize: "12px",
        outline: "none",
        minWidth: "0",
        height: "26px",
        fontFamily: "inherit",
        transition: "border-color 100ms ease, box-shadow 100ms ease",
    },
    ".cm-textfield:focus": {
        borderColor: "var(--accent)",
        boxShadow:
            "0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent)",
    },
    ".cm-textfield[name=search]": {
        flex: "1 1 180px",
    },

    ".cm-textfield[name=replace]": {
        flex: "1 1 180px",
        marginLeft: "0",
    },

    ".cm-button": {
        backgroundColor: "transparent",
        color: "var(--text-secondary)",
        border: "1px solid transparent",
        cursor: "pointer",
        padding: "0 8px",
        borderRadius: "6px",
        fontSize: "11px",
        fontWeight: "500",
        height: "26px",
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "nowrap",
        fontFamily: "inherit",
        flexShrink: "0",
        transition: "background-color 100ms ease, color 100ms ease",
    },
    ".cm-button:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)",
        color: "var(--text-primary)",
    },
    ".cm-button[name=next], .cm-button[name=prev]": {
        minWidth: "26px",
        padding: "0 6px",
    },
    ".cm-button[name=replace], .cm-button[name=replaceAll]": {
        background:
            "color-mix(in srgb, var(--bg-secondary) 80%, var(--bg-primary))",
        borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
    },

    ".cm-button[name=close]": {
        marginLeft: "auto",
        fontSize: "14px",
        width: "26px",
        padding: "0",
        color: "var(--text-secondary)",
        opacity: "0.6",
    },
    ".cm-button[name=close]:hover": {
        opacity: "1",
        color: "#ef4444",
        backgroundColor: "color-mix(in srgb, #ef4444 10%, transparent)",
    },

    ".cm-search label": {
        color: "var(--text-secondary)",
        fontSize: "10.5px",
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        cursor: "pointer",
        padding: "0 5px",
        borderRadius: "5px",
        height: "24px",
        whiteSpace: "nowrap",
        border: "1px solid transparent",
        background: "transparent",
        transition: "background-color 100ms ease, color 100ms ease",
    },
    ".cm-search label:hover": {
        color: "var(--text-primary)",
        backgroundColor:
            "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)",
    },
    ".cm-search input[type=checkbox]": {
        accentColor: "var(--accent)",
        cursor: "pointer",
        margin: "0",
        width: "12px",
        height: "12px",
    },

    ".cm-search br": {
        display: "block",
        flexBasis: "100%",
        height: "0",
        content: '""',
    },

    ".cm-search > *": {
        minWidth: "0",
    },

    "@media (max-width: 900px)": {
        ".cm-panels": {
            padding: "6px 8px 0",
        },
        ".cm-search": {
            gap: "4px",
            padding: "5px 6px",
        },
        ".cm-button[name=close]": {
            order: "-1",
            marginLeft: "0",
        },
        ".cm-textfield[name=search], .cm-textfield[name=replace]": {
            flexBasis: "100%",
        },
    },

    ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
        borderRadius: "3px",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)",
        outline: "1px solid var(--accent)",
        borderRadius: "3px",
    },
});
