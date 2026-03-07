import { EditorView } from "@codemirror/view";

export const searchTheme = EditorView.theme({
    // Floating panel container
    ".cm-panels": {
        display: "flex",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: "12px 16px 0",
    },
    ".cm-panels-top": {
        borderBottom: "none",
    },

    ".cm-search": {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "min(100%, 820px)",
        padding: "10px 12px",
        background:
            "color-mix(in srgb, var(--bg-primary) 88%, var(--bg-secondary))",
        border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
        borderRadius: "16px",
        boxShadow: "0 12px 32px rgba(0,0,0,0.10)",
        flexWrap: "wrap",
        backdropFilter: "blur(10px)",
    },

    ".cm-textfield": {
        backgroundColor: "color-mix(in srgb, var(--bg-primary) 94%, white 6%)",
        color: "var(--text-primary)",
        border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
        borderRadius: "10px",
        padding: "0 10px",
        fontSize: "12px",
        outline: "none",
        minWidth: "0",
        height: "32px",
        fontFamily: "inherit",
        transition: "border-color 140ms ease, box-shadow 140ms ease",
    },
    ".cm-textfield:focus": {
        borderColor: "var(--accent)",
        boxShadow:
            "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)",
    },
    ".cm-textfield[name=search]": {
        flex: "1 1 220px",
    },

    ".cm-textfield[name=replace]": {
        flex: "1 1 220px",
        marginLeft: "0",
    },

    ".cm-button": {
        backgroundColor: "transparent",
        color: "var(--text-secondary)",
        border: "1px solid transparent",
        cursor: "pointer",
        padding: "0 10px",
        borderRadius: "10px",
        fontSize: "11px",
        fontWeight: "600",
        height: "30px",
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "nowrap",
        fontFamily: "inherit",
        flexShrink: "0",
        letterSpacing: "0.01em",
        transition:
            "background-color 140ms ease, color 140ms ease, border-color 140ms ease",
    },
    ".cm-button:hover": {
        backgroundColor:
            "color-mix(in srgb, var(--bg-secondary) 70%, transparent)",
        color: "var(--text-primary)",
        borderColor: "color-mix(in srgb, var(--border) 80%, transparent)",
    },
    ".cm-button[name=next], .cm-button[name=prev]": {
        minWidth: "30px",
        padding: "0 9px",
    },
    ".cm-button[name=replace], .cm-button[name=replaceAll]": {
        background:
            "color-mix(in srgb, var(--bg-secondary) 82%, var(--bg-primary))",
        borderColor: "color-mix(in srgb, var(--border) 80%, transparent)",
    },

    ".cm-button[name=close]": {
        marginLeft: "auto",
        fontSize: "16px",
        width: "30px",
        padding: "0",
        color: "var(--text-primary)",
        opacity: "0.45",
    },
    ".cm-button[name=close]:hover": {
        opacity: "1",
        color: "#ef4444",
        backgroundColor: "color-mix(in srgb, #ef4444 12%, transparent)",
        borderColor: "transparent",
    },

    ".cm-search label": {
        color: "var(--text-secondary)",
        fontSize: "11px",
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        cursor: "pointer",
        padding: "0 8px",
        borderRadius: "999px",
        height: "28px",
        whiteSpace: "nowrap",
        border: "1px solid transparent",
        background: "transparent",
        transition:
            "background-color 140ms ease, color 140ms ease, border-color 140ms ease",
    },
    ".cm-search label:hover": {
        color: "var(--text-primary)",
        backgroundColor:
            "color-mix(in srgb, var(--bg-secondary) 72%, transparent)",
        borderColor: "color-mix(in srgb, var(--border) 78%, transparent)",
    },
    ".cm-search input[type=checkbox]": {
        accentColor: "var(--accent)",
        cursor: "pointer",
        margin: "0",
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
            padding: "10px 12px 0",
        },
        ".cm-search": {
            gap: "6px",
            padding: "10px",
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
        borderRadius: "4px",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)",
        outline: "1px solid var(--accent)",
        borderRadius: "4px",
    },
});
