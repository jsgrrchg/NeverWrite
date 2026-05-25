import { showPanel, type Panel, EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";

type VimModeChange = { mode: string; subMode?: string };

function formatMode(change: VimModeChange | null): string {
    if (!change) return "NORMAL";
    const base = change.mode === "visual" ? "VISUAL" : change.mode.toUpperCase();
    if (change.mode === "visual" && change.subMode) {
        if (change.subMode === "linewise") return "VISUAL LINE";
        if (change.subMode === "blockwise") return "VISUAL BLOCK";
    }
    return base;
}

// Bottom panel showing the current vim mode (NORMAL/INSERT/VISUAL/...), styled
// to match the editor chrome. The @replit/codemirror-vim engine renders the
// `:` ex-command input itself; this only adds the mode label. Included only
// when vim mode is active (see getVimExtension), so it disappears with vim.
function createVimStatusPanel(view: EditorView): Panel {
    const dom = document.createElement("div");
    dom.className = "cm-vim-mode-bar";

    const label = document.createElement("span");
    label.className = "cm-vim-mode-label";
    label.textContent = "NORMAL";
    dom.appendChild(label);

    const onModeChange = (change: VimModeChange) => {
        label.textContent = formatMode(change);
        label.dataset.mode = change.mode;
    };

    return {
        dom,
        top: false,
        mount() {
            const cm = getCM(view);
            cm?.on("vim-mode-change", onModeChange);
        },
        destroy() {
            const cm = getCM(view);
            cm?.off("vim-mode-change", onModeChange);
        },
    };
}

const vimStatusBarTheme = EditorView.baseTheme({
    ".cm-vim-mode-bar": {
        display: "flex",
        alignItems: "center",
        padding: "2px 10px",
        fontSize: "11px",
        fontFamily: "var(--editor-font-family)",
        color: "var(--text-secondary, var(--text-primary))",
        borderTop: "1px solid var(--app-border, transparent)",
        backgroundColor: "transparent",
        userSelect: "none",
    },
    ".cm-vim-mode-label": {
        fontWeight: "600",
        letterSpacing: "0.05em",
    },
    // The package leaves the ex-command (`:`) input uncolored, so it renders
    // black on the dark editor theme. Color it like editor text.
    ".cm-vim-panel": {
        color: "var(--text-primary)",
        fontFamily: "var(--editor-font-family)",
    },
    ".cm-vim-panel input": {
        color: "var(--text-primary)",
        caretColor: "var(--text-primary)",
    },
    // The block cursor inherits the font-size of the DOM node it sits on. On a
    // live-preview list line that node is the zero-`font-size` hidden marker,
    // which collapses the cursor to zero width. Give it a minimum width tied
    // to the editor font size so it stays visible regardless of the underlying
    // node's font-size.
    ".cm-vimMode .cm-fat-cursor": {
        minWidth: "calc(var(--editor-font-size, 14px) * 0.5)",
    },
});

export const vimStatusBarExtension = [
    showPanel.of(createVimStatusPanel),
    vimStatusBarTheme,
];
