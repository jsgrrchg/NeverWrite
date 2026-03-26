import { EditorView, type Panel } from "@codemirror/view";
import {
    SearchQuery,
    setSearchQuery,
    getSearchQuery,
    findNext,
    findPrevious,
    closeSearchPanel,
} from "@codemirror/search";

/**
 * Search match highlight theme — must be included in the editor extensions
 * to style matches in the document.
 */
export const markdownSearchMatchTheme = EditorView.theme({
    ".cm-panels": {
        background: "transparent",
        border: "none",
    },
    ".cm-panels-top": {
        borderBottom: "none",
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

/* ── context menu bridge ──────────────────────────────────────── */

export interface SearchPanelOptions {
    caseSensitive: boolean;
    regexp: boolean;
    wholeWord: boolean;
}

type ContextMenuCallback = (
    x: number,
    y: number,
    options: SearchPanelOptions,
    toggle: (key: keyof SearchPanelOptions) => void,
) => void;

let contextMenuCb: ContextMenuCallback | null = null;

export function setSearchPanelContextMenuCallback(
    cb: ContextMenuCallback | null,
) {
    contextMenuCb = cb;
}

/* ── match counting ───────────────────────────────────────────── */

function countMatches(
    view: EditorView,
    query: SearchQuery,
): { total: number; current: number } {
    if (!query.search || !query.valid) return { total: 0, current: 0 };

    const cursor = query.getCursor(view.state.doc);
    let total = 0;
    let current = 0;
    const sel = view.state.selection.main.from;

    while (!cursor.next().done) {
        total++;
        if (
            cursor.value.from <= sel &&
            cursor.value.to >= sel &&
            current === 0
        ) {
            current = total;
        }
    }
    return { total, current };
}

/* ── panel factory ────────────────────────────────────────────── */

export function createMarkdownSearchPanel(view: EditorView): Panel {
    let options: SearchPanelOptions = {
        caseSensitive: false,
        regexp: false,
        wholeWord: false,
    };

    // ── DOM structure ──
    const container = document.createElement("div");
    container.className = "md-search-bar";
    Object.assign(container.style, {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        maxWidth: "420px",
        margin: "0 auto",
        padding: "4px 6px",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
    });

    // Wrapper for the panels area
    const panelsWrap = document.createElement("div");
    Object.assign(panelsWrap.style, {
        display: "flex",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: "4px 12px 0",
    });
    panelsWrap.appendChild(container);

    // Input
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find…";
    input.setAttribute("main-field", "true");
    Object.assign(input.style, {
        flex: "1",
        minWidth: "0",
        height: "24px",
        padding: "0 7px",
        fontSize: "12px",
        fontFamily: "inherit",
        color: "var(--text-primary)",
        backgroundColor:
            "color-mix(in srgb, var(--bg-primary) 70%, var(--bg-secondary))",
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        borderRadius: "5px",
        outline: "none",
        transition: "border-color 100ms ease",
    });
    input.addEventListener("focus", () => {
        input.style.borderColor = "var(--accent)";
    });
    input.addEventListener("blur", () => {
        input.style.borderColor =
            "color-mix(in srgb, var(--border) 60%, transparent)";
    });

    // Match count
    const matchLabel = document.createElement("span");
    Object.assign(matchLabel.style, {
        fontSize: "10px",
        color: "var(--text-secondary)",
        whiteSpace: "nowrap",
        padding: "0 2px",
        minWidth: "36px",
        textAlign: "center",
    });

    // Navigation buttons helper
    function makeBtn(ariaLabel: string, svgPath: string): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.title = ariaLabel;
        btn.setAttribute("aria-label", ariaLabel);
        Object.assign(btn.style, {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "22px",
            height: "22px",
            padding: "0",
            border: "none",
            borderRadius: "4px",
            background: "transparent",
            color: "var(--text-secondary)",
            cursor: "pointer",
            flexShrink: "0",
            transition: "background 100ms, color 100ms",
        });
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
        btn.addEventListener("mouseenter", () => {
            btn.style.background =
                "color-mix(in srgb, var(--text-secondary) 12%, transparent)";
            btn.style.color = "var(--text-primary)";
        });
        btn.addEventListener("mouseleave", () => {
            btn.style.background = "transparent";
            btn.style.color = "var(--text-secondary)";
        });
        return btn;
    }

    const prevBtn = makeBtn("Previous match", '<path d="M4 10L8 6L12 10"/>');
    const nextBtn = makeBtn("Next match", '<path d="M4 6L8 10L12 6"/>');
    const closeBtn = makeBtn(
        "Close search",
        '<path d="M4 4L12 12M12 4L4 12"/>',
    );
    Object.assign(closeBtn.style, {
        marginLeft: "2px",
        opacity: "0.5",
    });
    closeBtn.addEventListener("mouseenter", () => {
        closeBtn.style.opacity = "1";
        closeBtn.style.color = "#ef4444";
        closeBtn.style.background =
            "color-mix(in srgb, #ef4444 10%, transparent)";
    });
    closeBtn.addEventListener("mouseleave", () => {
        closeBtn.style.opacity = "0.5";
        closeBtn.style.color = "var(--text-secondary)";
        closeBtn.style.background = "transparent";
    });

    container.append(input, matchLabel, prevBtn, nextBtn, closeBtn);

    // ── state helpers ──
    function dispatchQuery() {
        const query = new SearchQuery({
            search: input.value,
            caseSensitive: options.caseSensitive,
            regexp: options.regexp,
            wholeWord: options.wholeWord,
        });
        view.dispatch({ effects: setSearchQuery.of(query) });
    }

    function updateMatchCount() {
        const query = getSearchQuery(view.state);
        if (!query.search) {
            matchLabel.textContent = "";
            return;
        }
        const { total, current } = countMatches(view, query);
        matchLabel.textContent =
            total === 0 ? "No results" : `${current}/${total}`;
    }

    function toggleOption(key: keyof SearchPanelOptions) {
        options[key] = !options[key];
        dispatchQuery();
        updateMatchCount();
    }

    // ── events ──
    input.addEventListener("input", () => {
        dispatchQuery();
        updateMatchCount();
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) {
                findPrevious(view);
            } else {
                findNext(view);
            }
            // Update count after navigation to reflect current position
            requestAnimationFrame(() => updateMatchCount());
        }
        if (e.key === "Escape") {
            e.preventDefault();
            closeSearchPanel(view);
        }
    });

    prevBtn.addEventListener("click", () => {
        findPrevious(view);
        requestAnimationFrame(() => updateMatchCount());
    });
    nextBtn.addEventListener("click", () => {
        findNext(view);
        requestAnimationFrame(() => updateMatchCount());
    });
    closeBtn.addEventListener("click", () => {
        closeSearchPanel(view);
    });

    // Context menu → bridge to React
    container.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextMenuCb?.(e.clientX, e.clientY, { ...options }, toggleOption);
    });

    // ── Panel interface ──
    return {
        dom: panelsWrap,
        top: true,
        mount() {
            const query = getSearchQuery(view.state);
            input.value = query.search;
            options.caseSensitive = query.caseSensitive;
            options.regexp = query.regexp;
            options.wholeWord = query.wholeWord;
            input.focus();
            input.select();
            updateMatchCount();
        },
        update(update) {
            if (update.docChanged || update.selectionSet) {
                updateMatchCount();
            }
        },
    };
}
