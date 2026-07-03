import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    WidgetType,
} from "@codemirror/view";
import {
    type Extension,
    type EditorState,
    RangeSetBuilder,
    StateField,
    type Transaction,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import katex from "katex";
import {
    buildVaultPreviewUrlFromAbsolutePath,
    isAuthorizedVaultPreviewPath,
} from "../../../app/utils/filePreviewUrl";
import {
    dispatchOpenYouTubeModal,
    extractYouTubeVideoId,
    getYouTubePreview,
    getYouTubeThumbnailUrl,
} from "../youtube";

import {
    useEditorStore,
    isNoteTab,
    selectFocusedEditorTab,
} from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { emitFileTreeNoteDrag } from "../../ai/dragEvents";
import {
    type DecoEntry,
    findHighlightRanges,
    linkReferenceField,
    findAncestor,
    normalizeReferenceLabel,
    parseLinkChildren,
    resolveLinkHref,
} from "./livePreviewHelpers";
import {
    selectionTouchesLine,
    selectionTouchesRange,
} from "./selectionActivity";
import {
    extractSection,
    findPreviewNote,
    getNotePreviewContentState,
    renderEmbedPreview,
} from "./notePreviewSource";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)([?#].*)?$/i;
const PDF_EXTENSION = /\.pdf([?#].*)?$/i;
const MAX_REMOTE_IMAGE_URL_LENGTH = 4096;
const TABLE_WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const TABLE_URL_RE = /https?:\/\/[^\s<>()"\]]+/g;
const TABLE_BOLD_RE = /\*\*(?=\S)(.+?\S)\*\*/g;
const STANDALONE_URL_RE = /^https?:\/\/[^\s<>()"\]]+$/i;
type TableAlignment = "left" | "center" | "right";
export interface TableInteractionHandlers {
    resolveWikilink: (target: string) => boolean;
    navigateWikilink: (target: string) => void;
    getNoteLinkTarget: (href: string) => string | null;
    openLinkContextMenu: (payload: {
        x: number;
        y: number;
        href: string;
        noteTarget: string | null;
    }) => void;
}
type ParsedTableCell = {
    content: string;
    from: number;
    to: number;
};
type ParsedTableRow = {
    cells: ParsedTableCell[];
    lineEnd: number;
};
type FencedCodeBlockKind = "code" | "mermaid";
type FencedCodeBlockPreview = {
    kind: FencedCodeBlockKind;
    info: string;
    language: string;
    code: string;
    hasContent: boolean;
    openEnd: number;
    closeFrom: number;
    firstContentLineNumber: number;
    lastContentLineNumber: number;
};

// Re-exported under its historical name; the implementation now lives in the
// shared note-preview source consumed by both embeds and hover previews.
export { invalidateNotePreviewCache as invalidateLivePreviewNoteCache } from "./notePreviewSource";

function getActiveNotePath() {
    const activeTab = selectFocusedEditorTab(useEditorStore.getState());
    if (!activeTab || !isNoteTab(activeTab)) return null;

    return (
        useVaultStore
            .getState()
            .notes.find((note) => note.id === activeTab.noteId)?.path ?? null
    );
}

function stripUrlSuffix(value: string) {
    const marker = value.search(/[?#]/);
    return marker === -1
        ? { pathname: value, suffix: "" }
        : {
              pathname: value.slice(0, marker),
              suffix: value.slice(marker),
          };
}

function getPathSeparator(value: string) {
    return value.includes("\\") && !value.includes("/") ? "\\" : "/";
}

function splitPathPrefix(value: string) {
    const normalized = value.replace(/\\/g, "/");
    const driveMatch = normalized.match(/^[A-Za-z]:/);
    if (driveMatch) {
        return {
            prefix: driveMatch[0],
            segments: normalized
                .slice(driveMatch[0].length)
                .split("/")
                .filter(Boolean),
        };
    }

    if (normalized.startsWith("//")) {
        const uncSegments = normalized.slice(2).split("/").filter(Boolean);
        const server = uncSegments.shift();
        const share = uncSegments.shift();
        if (server && share) {
            return {
                prefix: `//${server}/${share}`,
                segments: uncSegments,
            };
        }
    }

    return {
        prefix: normalized.startsWith("/") ? "/" : "",
        segments: normalized.split("/").filter(Boolean),
    };
}

function joinFilePath(basePath: string, relativePath: string) {
    const separator = getPathSeparator(basePath);
    const { prefix, segments } = splitPathPrefix(basePath);
    const relativeSegments = relativePath.replace(/\\/g, "/").split("/");
    const output = [...segments];

    for (const segment of relativeSegments) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
            if (output.length > 0) output.pop();
            continue;
        }
        output.push(segment);
    }

    const joined = prefix
        ? `${prefix}${prefix.endsWith("/") || output.length === 0 ? "" : "/"}${output.join("/")}`
        : output.join("/");
    return separator === "\\" ? joined.replace(/\//g, "\\") : joined;
}

function getParentPath(filePath: string) {
    const separator = getPathSeparator(filePath);
    const normalized = filePath.replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    if (index <= 0) {
        if (normalized.match(/^[A-Za-z]:/)) {
            return normalized
                .slice(0, normalized.indexOf("/") + 1)
                .replace(/\//g, separator);
        }
        return normalized.startsWith("/") ? "/" : "";
    }
    const parent = normalized.slice(0, index);
    return separator === "\\" ? parent.replace(/\//g, "\\") : parent;
}

function isAbsoluteFilePath(value: string) {
    return value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function resolvePreviewAssetPath(
    rawUrl: string,
    vaultRoot: string | null,
    notePath: string | null,
) {
    if (
        rawUrl.startsWith("http://") ||
        rawUrl.startsWith("https://") ||
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("file://")
    ) {
        return rawUrl;
    }

    const { pathname, suffix } = stripUrlSuffix(rawUrl.trim());
    if (!pathname) return rawUrl;

    if (isAbsoluteFilePath(pathname)) {
        return `${pathname}${suffix}`;
    }

    if (pathname.startsWith("/")) {
        if (!vaultRoot) return `${pathname}${suffix}`;
        return `${joinFilePath(vaultRoot, pathname.slice(1))}${suffix}`;
    }

    const baseDirectory = notePath ? getParentPath(notePath) : vaultRoot;
    if (!baseDirectory) {
        return `${pathname}${suffix}`;
    }

    return `${joinFilePath(baseDirectory, pathname)}${suffix}`;
}

// --- Image size toolbar ---

const IMAGE_SIZE_PRESETS: { label: string; width: number | null }[] = [
    { label: "S", width: 200 },
    { label: "M", width: 400 },
    { label: "L", width: null },
];

function buildImageSizeToolbar(
    from: number,
    to: number,
    currentWidth: number | null,
): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "cm-image-size-toolbar";
    for (const preset of IMAGE_SIZE_PRESETS) {
        const btn = document.createElement("button");
        btn.className = "cm-image-size-btn";
        if (preset.width === currentWidth) {
            btn.classList.add("cm-image-size-btn-active");
        }
        btn.textContent = preset.label;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            btn.dispatchEvent(
                new CustomEvent("cm-image-resize", {
                    bubbles: true,
                    detail: { from, to, width: preset.width },
                }),
            );
        });
        toolbar.appendChild(btn);
    }
    return toolbar;
}

function buildResizedWikilink(
    oldText: string,
    newWidth: number | null,
): string {
    const match = oldText.match(/^!\[\[([^|\]]+)(?:\|[^\]]*?)?\]\]$/);
    if (!match) return oldText;
    const target = match[1];
    if (newWidth == null) return `![[${target}]]`;
    return `![[${target}|${newWidth}]]`;
}

function getMimeTypeFromPath(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        ico: "image/x-icon",
        avif: "image/avif",
        pdf: "application/pdf",
    };
    return map[ext] ?? "application/octet-stream";
}

const DRAG_THRESHOLD = 5;

// Inject global drag cursor style once
let dragStyleInjected = false;
function ensureDragStyle() {
    if (dragStyleInjected) return;
    dragStyleInjected = true;
    const style = document.createElement("style");
    style.textContent =
        "body.neverwrite-embed-dragging,body.neverwrite-embed-dragging *{cursor:grabbing!important;user-select:none!important}";
    document.head.appendChild(style);
}

function createDragGhost(label: string, x: number, y: number): HTMLElement {
    const ghost = document.createElement("div");
    ghost.textContent = label;
    ghost.style.cssText = [
        "position:fixed",
        "pointer-events:none",
        "z-index:99999",
        "padding:5px 12px",
        "border-radius:8px",
        "font-size:12px",
        "font-family:system-ui,sans-serif",
        "background:var(--accent,#3b82f6)",
        "color:white",
        "opacity:0.92",
        "white-space:nowrap",
        "box-shadow:0 4px 12px rgba(0,0,0,0.25)",
        "transform:translate(-50%,-120%)",
    ].join(";");
    ghost.style.left = x + "px";
    ghost.style.top = y + "px";
    document.body.appendChild(ghost);
    return ghost;
}

function setupEmbedDrag(element: HTMLElement, resolvedPath: string) {
    const fileName = resolvedPath.split("/").pop() ?? "file";
    const mimeType = getMimeTypeFromPath(resolvedPath);
    const file = { filePath: resolvedPath, fileName, mimeType };
    element.style.cursor = "grab";

    element.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();

        const startX = e.clientX;
        const startY = e.clientY;
        let started = false;
        let ghost: HTMLElement | null = null;

        const onMove = (ev: MouseEvent) => {
            ev.preventDefault();
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!started && dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD)
                return;
            if (!started) {
                started = true;
                ensureDragStyle();
                document.body.classList.add("neverwrite-embed-dragging");
                element.style.opacity = "0.35";
                ghost = createDragGhost(fileName, ev.clientX, ev.clientY);
                emitFileTreeNoteDrag({
                    phase: "start",
                    x: ev.clientX,
                    y: ev.clientY,
                    notes: [],
                    files: [file],
                });
            }
            if (ghost) {
                ghost.style.left = ev.clientX + "px";
                ghost.style.top = ev.clientY + "px";
            }
            emitFileTreeNoteDrag({
                phase: "move",
                x: ev.clientX,
                y: ev.clientY,
                notes: [],
                files: [file],
            });
        };

        const onUp = (ev: MouseEvent) => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            if (started) {
                element.style.opacity = "";
                document.body.classList.remove("neverwrite-embed-dragging");
                ghost?.remove();
                emitFileTreeNoteDrag({
                    phase: "end",
                    x: ev.clientX,
                    y: ev.clientY,
                    notes: [],
                    files: [file],
                });
            }
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
}

class ImageWidget extends WidgetType {
    private src: string;
    private alt: string;
    private href: string | null;
    private title: string | null;
    private from: number;
    private to: number;
    private width: number | null;
    private isWikilink: boolean;
    private resolvedPath: string | null;

    constructor(
        src: string,
        alt: string,
        from: number,
        to: number,
        href: string | null = null,
        title: string | null = null,
        width: number | null = null,
        isWikilink = false,
        resolvedPath: string | null = null,
    ) {
        super();
        this.src = src;
        this.alt = alt;
        this.href = href;
        this.title = title;
        this.from = from;
        this.to = to;
        this.width = width;
        this.isWikilink = isWikilink;
        this.resolvedPath = resolvedPath;
    }

    eq(other: ImageWidget) {
        return (
            this.src === other.src &&
            this.alt === other.alt &&
            this.href === other.href &&
            this.title === other.title &&
            this.width === other.width
        );
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-inline-image-wrapper";
        wrapper.setAttribute("contenteditable", "false");
        wrapper.dataset.sourceFrom = String(this.from);
        wrapper.dataset.sourceTo = String(this.to);
        if (this.isWikilink) {
            wrapper.dataset.embedTarget = this.alt;
            wrapper.dataset.embedKind = "image";
        }

        const content = document.createElement("div");
        content.className = "cm-inline-image-content";
        if (this.isWikilink && this.resolvedPath) {
            setupEmbedDrag(content, this.resolvedPath);
        }
        if (this.href) {
            content.classList.add("cm-inline-image-link");
            content.dataset.href = this.href;
            content.tabIndex = 0;
            content.setAttribute("role", "link");
        }

        const img = document.createElement("img");
        img.src = this.src;
        img.alt = this.alt;
        img.className = "cm-inline-image";
        img.draggable = false;
        img.loading = "lazy";
        img.decoding = "async";
        if (this.title) img.title = this.title;
        if (this.width) {
            img.style.width = `${this.width}px`;
            img.style.maxWidth = "100%";
        }

        img.onerror = () => {
            img.style.display = "none";
            const fallback = document.createElement("span");
            fallback.className = "cm-inline-image-fallback";
            fallback.textContent = `Image not found: ${truncateInlineImageLabel(
                this.alt || this.src,
            )}`;
            content.appendChild(fallback);
        };

        content.appendChild(img);

        if (this.isWikilink) {
            const toolbar = buildImageSizeToolbar(
                this.from,
                this.to,
                this.width,
            );
            wrapper.appendChild(toolbar);
        }

        wrapper.appendChild(content);
        return wrapper;
    }

    ignoreEvent() {
        return true;
    }
}

class SkippedImageWidget extends WidgetType {
    private label: string;
    private from: number;
    private to: number;

    constructor(label: string, from: number, to: number) {
        super();
        this.label = label;
        this.from = from;
        this.to = to;
    }

    eq(other: SkippedImageWidget) {
        return this.label === other.label;
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-inline-image-wrapper";
        wrapper.setAttribute("contenteditable", "false");
        wrapper.dataset.sourceFrom = String(this.from);
        wrapper.dataset.sourceTo = String(this.to);

        const fallback = document.createElement("span");
        fallback.className = "cm-inline-image-fallback";
        fallback.textContent = this.label;

        wrapper.appendChild(fallback);
        return wrapper;
    }

    ignoreEvent() {
        return true;
    }
}

class PdfEmbedWidget extends WidgetType {
    private fileName: string;
    private target: string;
    private from: number;
    private to: number;
    private resolvedPath: string | null;

    constructor(
        fileName: string,
        target: string,
        from: number,
        to: number,
        resolvedPath: string | null = null,
    ) {
        super();
        this.fileName = fileName;
        this.target = target;
        this.from = from;
        this.to = to;
        this.resolvedPath = resolvedPath;
    }

    eq(other: PdfEmbedWidget) {
        return this.target === other.target;
    }

    toDOM() {
        const wrapper = document.createElement("div");
        wrapper.className = "cm-pdf-embed-wrapper";
        wrapper.setAttribute("contenteditable", "false");
        wrapper.dataset.sourceFrom = String(this.from);
        wrapper.dataset.sourceTo = String(this.to);
        wrapper.dataset.embedTarget = this.target;
        wrapper.dataset.embedKind = "pdf";
        if (this.resolvedPath) setupEmbedDrag(wrapper, this.resolvedPath);

        const chip = document.createElement("div");
        chip.className = "cm-pdf-embed-chip";
        chip.dataset.wikilinkTarget = this.target;

        const icon = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
        );
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "1.5");
        icon.setAttribute("stroke-linecap", "round");
        icon.setAttribute("stroke-linejoin", "round");
        icon.setAttribute("class", "cm-pdf-embed-icon");
        icon.innerHTML =
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/>' +
            '<path d="M14 2v6h6"/><path d="M10 13v4"/>' +
            '<path d="M14 13v4"/><path d="M10 13h4"/>';

        const name = document.createElement("span");
        name.className = "cm-pdf-embed-name";
        name.textContent = this.fileName;

        chip.appendChild(icon);
        chip.appendChild(name);
        wrapper.appendChild(chip);
        return wrapper;
    }

    ignoreEvent() {
        return true;
    }
}

class YouTubeWidget extends WidgetType {
    private href: string;
    private title: string;
    private from: number;
    private to: number;

    constructor(href: string, title: string, from: number, to: number) {
        super();
        this.href = href;
        this.title = title;
        this.from = from;
        this.to = to;
    }

    eq(other: YouTubeWidget) {
        return this.href === other.href && this.title === other.title;
    }

    toDOM() {
        // Outer wrapper uses padding (not margin) so CodeMirror's height map
        // accounts for the spacing. Margins on block widgets are invisible to
        // CodeMirror's offsetHeight measurement and cause click offset issues.
        const outer = document.createElement("div");
        outer.className = "cm-youtube-link-wrapper";
        outer.dataset.sourceFrom = String(this.from);
        outer.dataset.sourceTo = String(this.to);
        outer.setAttribute("contenteditable", "false");

        const wrapper = document.createElement("div");
        wrapper.className = "cm-youtube-link";
        wrapper.dataset.href = this.href;
        wrapper.dataset.title = this.title;
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "button");
        const openVideo = () => {
            dispatchOpenYouTubeModal({
                href: this.href,
                title: wrapper.dataset.title || this.title || "YouTube video",
            });
        };
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openVideo();
        });
        wrapper.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            openVideo();
        });

        const media = document.createElement("div");
        media.className = "cm-youtube-link-media";

        const thumbnail = document.createElement("img");
        thumbnail.className = "cm-youtube-link-thumbnail";
        thumbnail.alt = this.title;
        thumbnail.loading = "lazy";
        thumbnail.decoding = "async";

        const thumbnailUrl = getYouTubeThumbnailUrl(this.href);
        if (thumbnailUrl) {
            thumbnail.src = thumbnailUrl;
        } else {
            media.dataset.noThumbnail = "true";
        }
        thumbnail.onerror = () => {
            media.dataset.noThumbnail = "true";
        };

        const play = document.createElement("div");
        play.className = "cm-youtube-link-play";
        play.setAttribute("aria-hidden", "true");

        media.appendChild(thumbnail);
        media.appendChild(play);

        const body = document.createElement("div");
        body.className = "cm-youtube-link-body";

        const label = document.createElement("div");
        label.className = "cm-youtube-link-label";
        label.textContent = this.title;

        const meta = document.createElement("div");
        meta.className = "cm-youtube-link-meta";
        meta.textContent = "Play in app";

        body.appendChild(label);
        body.appendChild(meta);

        wrapper.appendChild(media);
        wrapper.appendChild(body);

        void getYouTubePreview(this.href).then((preview) => {
            if (!outer.isConnected) return;

            if (
                preview.thumbnailUrl &&
                thumbnail.src !== preview.thumbnailUrl
            ) {
                thumbnail.src = preview.thumbnailUrl;
            }

            if (preview.title) {
                label.textContent = preview.title;
                thumbnail.alt = preview.title;
                wrapper.dataset.title = preview.title;
            }
        });

        outer.appendChild(wrapper);
        return outer;
    }

    ignoreEvent(event: Event) {
        return event.type !== "contextmenu";
    }
}

const EMBED_MAX_LINES = 6;

class NoteEmbedWidget extends WidgetType {
    private target: string;
    private heading?: string;
    private from: number;
    private to: number;

    constructor(target: string, from: number, to: number, heading?: string) {
        super();
        this.target = target;
        this.from = from;
        this.to = to;
        this.heading = heading;
    }

    eq(other: NoteEmbedWidget) {
        return this.target === other.target && this.heading === other.heading;
    }

    toDOM() {
        // Outer wrapper uses padding so CodeMirror's height map is accurate.
        // Margins on block widgets are not included in offsetHeight.
        const outer = document.createElement("div");
        outer.className = "cm-note-embed-wrapper";
        outer.dataset.sourceFrom = String(this.from);
        outer.dataset.sourceTo = String(this.to);
        outer.setAttribute("contenteditable", "false");

        const wrapper = document.createElement("div");
        wrapper.className = "cm-note-embed";
        wrapper.dataset.wikilinkTarget = this.target;
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "link");

        const note = findPreviewNote(this.target);

        const title = document.createElement("div");
        title.className = "cm-note-embed-title";
        title.textContent = this.heading
            ? `${note?.title ?? this.target} > ${this.heading}`
            : (note?.title ?? this.target);
        wrapper.appendChild(title);

        const renderContent = (fullContent: string | null) => {
            wrapper
                .querySelectorAll(".cm-note-embed-meta, .cm-note-embed-preview")
                .forEach((node) => node.remove());

            const section = fullContent
                ? this.heading
                    ? extractSection(fullContent, this.heading)
                    : fullContent
                : "";

            if (section.trim()) {
                const preview = document.createElement("div");
                preview.className = "cm-note-embed-preview";
                preview.appendChild(
                    renderEmbedPreview(section, EMBED_MAX_LINES),
                );
                wrapper.appendChild(preview);
                return;
            }

            const meta = document.createElement("div");
            meta.className = "cm-note-embed-meta";
            meta.textContent = fullContent
                ? this.heading
                    ? "Section not found"
                    : "Empty note"
                : (note?.path ?? this.target);
            wrapper.appendChild(meta);
        };

        const { content, load } = getNotePreviewContentState(
            note,
            this.target,
        );
        if (content !== null) {
            renderContent(content);
            outer.appendChild(wrapper);
            return outer;
        }

        renderContent(null);

        if (load) {
            void load().then((loaded) => {
                if (!outer.isConnected || loaded === null) return;
                renderContent(loaded);
            });
        }

        outer.appendChild(wrapper);
        return outer;
    }

    ignoreEvent() {
        return true;
    }
}

class CodeBlockHeaderWidget extends WidgetType {
    private kind: FencedCodeBlockKind;
    private language: string;
    private code: string;
    private hasContent: boolean;

    constructor(
        kind: FencedCodeBlockKind,
        language: string,
        code: string,
        hasContent: boolean,
    ) {
        super();
        this.kind = kind;
        this.language = language;
        this.code = code;
        this.hasContent = hasContent;
    }

    eq(other: CodeBlockHeaderWidget) {
        return (
            this.kind === other.kind &&
            this.language === other.language &&
            this.code === other.code &&
            this.hasContent === other.hasContent
        );
    }

    toDOM() {
        // Keep preview spacing inside the measured widget. Vertical margins on
        // CodeMirror block widgets are not included in its height map, which
        // makes pointer-to-caret mapping drift after repeated code cards.
        const shell = document.createElement("div");
        shell.className = "cm-code-block-header-shell";
        shell.setAttribute("contenteditable", "false");

        const bar = document.createElement("div");
        bar.className = this.hasContent
            ? "cm-code-block-header"
            : "cm-code-block-header cm-code-block-header-only";
        bar.dataset.codeBlockKind = this.kind;
        bar.setAttribute("contenteditable", "false");

        const lang = document.createElement("span");
        lang.className = "cm-code-block-lang";
        lang.textContent = this.language || "text";

        const copyBtn = document.createElement("button");
        copyBtn.className = "cm-code-block-copy";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            void navigator.clipboard.writeText(this.code).then(() => {
                copyBtn.textContent = "Copied!";
                setTimeout(() => {
                    copyBtn.textContent = "Copy";
                }, 1500);
            });
        });

        bar.appendChild(lang);
        bar.appendChild(copyBtn);
        shell.appendChild(bar);
        return shell;
    }

    ignoreEvent() {
        return true;
    }
}

const codeBlockFenceHidden = Decoration.line({
    class: "cm-code-block-fence-hidden",
});
const codeBlockLine = Decoration.line({ class: "cm-code-block-line" });
const codeBlockLineFirst = Decoration.line({
    class: "cm-code-block-line cm-code-block-line-first",
});
const codeBlockLineLast = Decoration.line({
    class: "cm-code-block-line cm-code-block-line-last",
});
const codeBlockLineOnly = Decoration.line({
    class: "cm-code-block-line cm-code-block-line-first cm-code-block-line-last",
});

export function getFencedCodeBlockKind(info: string): FencedCodeBlockKind {
    return info.trimStart().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid"
        ? "mermaid"
        : "code";
}

function getFencedCodeBlockPreview(
    state: EditorState,
    node: SyntaxNode,
): FencedCodeBlockPreview | null {
    const cursor = node.cursor();
    let openEnd = -1;
    let closeFrom = -1;

    if (cursor.firstChild()) {
        do {
            if (cursor.name !== "CodeMark") continue;
            if (openEnd < 0) {
                openEnd = state.doc.lineAt(cursor.from).to;
            } else {
                closeFrom = cursor.from;
            }
        } while (cursor.nextSibling());
    }

    if (openEnd < 0) return null;

    const openLine = state.doc.lineAt(node.from);
    const firstContentLineNumber = openLine.number + 1;
    const lastContentLineNumber =
        closeFrom >= 0
            ? state.doc.lineAt(closeFrom).number - 1
            : state.doc.lineAt(node.to).number;
    const hasContent = firstContentLineNumber <= lastContentLineNumber;
    const infoNode = node.getChild("CodeInfo");
    const info = infoNode
        ? state.doc.sliceString(infoNode.from, infoNode.to).trim()
        : "";
    const contentStart = Math.min(openEnd + 1, node.to);
    const contentEnd =
        closeFrom >= 0 ? Math.max(contentStart, closeFrom) : node.to;
    let code = state.doc.sliceString(contentStart, contentEnd);
    if (code.endsWith("\n")) {
        code = code.slice(0, -1);
    }

    return {
        kind: getFencedCodeBlockKind(info),
        info,
        language: info,
        code,
        hasContent,
        openEnd,
        closeFrom,
        firstContentLineNumber,
        lastContentLineNumber,
    };
}

function buildCodeBlockDecorations(state: EditorState): DecorationSet {
    const decos: DecoEntry[] = [];

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== "FencedCode") return;

            const previewBlock = getFencedCodeBlockPreview(state, node.node);
            if (!previewBlock) return;
            if (
                previewBlock.kind === "mermaid" &&
                previewBlock.closeFrom < 0
            ) {
                return;
            }

            const showHeader = true;

            const openLine = state.doc.lineAt(node.from);

            if (showHeader) {
                decos.push({
                    from: node.from,
                    to: node.from,
                    deco: Decoration.widget({
                        widget: new CodeBlockHeaderWidget(
                            previewBlock.kind,
                            previewBlock.language,
                            previewBlock.code,
                            previewBlock.hasContent,
                        ),
                        block: true,
                        side: -1,
                    }),
                });
            }

            // Collapse the opening fence line (```lang) so it takes no space
            decos.push({
                from: openLine.from,
                to: openLine.from,
                deco: codeBlockFenceHidden,
            });

            // Collapse the closing fence line (```) so it takes no space
            if (previewBlock.closeFrom >= 0) {
                const closeLine = state.doc.lineAt(previewBlock.closeFrom);
                decos.push({
                    from: closeLine.from,
                    to: closeLine.from,
                    deco: codeBlockFenceHidden,
                });
            }

            for (
                let lineNum = previewBlock.firstContentLineNumber;
                lineNum <= previewBlock.lastContentLineNumber;
                lineNum++
            ) {
                const line = state.doc.line(lineNum);
                const isFirst =
                    lineNum === previewBlock.firstContentLineNumber;
                const isLast = lineNum === previewBlock.lastContentLineNumber;
                const needFirst = isFirst && !showHeader;

                let deco: Decoration;
                if (needFirst && isLast) deco = codeBlockLineOnly;
                else if (needFirst) deco = codeBlockLineFirst;
                else if (isLast) deco = codeBlockLineLast;
                else deco = codeBlockLine;

                decos.push({ from: line.from, to: line.from, deco });
            }
        },
    });

    decos.sort((a, b) => a.from - b.from || a.to - b.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to, deco } of decos) {
        builder.add(from, to, deco);
    }
    return builder.finish();
}

/**
 * Characters that can create or destroy block-level elements (code blocks,
 * math blocks, tables, images, embeds).  When a doc change only inserts /
 * deletes characters outside this set we can cheaply remap existing
 * decorations instead of rebuilding them from scratch.
 */
const BLOCK_MARKER_RE = /(?:[`$!|\n#]|\[)/;

/** Returns true when a transaction requires block decorations to be rebuilt. */
function needsBlockRebuild(tr: Transaction): boolean {
    if (tr.docChanged) {
        // Fast-path: for simple edits that cannot create / destroy block
        // elements, skip the expensive full rebuild.
        let hasPotentialBlockChange = false;
        tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
            if (hasPotentialBlockChange) return;
            // Check deleted text
            if (toA - fromA > 0) {
                const deleted = tr.startState.doc.sliceString(fromA, toA);
                if (BLOCK_MARKER_RE.test(deleted)) {
                    hasPotentialBlockChange = true;
                    return;
                }
            }
            // Check inserted text
            if (toB - fromB > 0) {
                const inserted = tr.state.doc.sliceString(fromB, toB);
                if (BLOCK_MARKER_RE.test(inserted)) {
                    hasPotentialBlockChange = true;
                    return;
                }
            }
        });
        return hasPotentialBlockChange;
    }
    if (!tr.selection) return false;
    const prev = tr.startState.selection.main;
    const curr = tr.state.selection.main;
    if (prev.empty !== curr.empty) return true;
    return (
        tr.state.doc.lineAt(curr.head).number !==
        tr.startState.doc.lineAt(prev.head).number
    );
}

function needsSyntaxBackedBlockRebuild(tr: Transaction): boolean {
    // CodeMirror may finish markdown parsing in a background language-state
    // transaction with no document or selection change. Syntax-backed widgets
    // must rebuild when new nodes become available.
    if (!tr.docChanged && syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return true;
    }
    return needsBlockRebuild(tr);
}

export function createCodeBlockLivePreviewExtension() {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildCodeBlockDecorations(state);
        },
        update(decorations, transaction) {
            if (!needsSyntaxBackedBlockRebuild(transaction)) {
                return transaction.docChanged
                    ? decorations.map(transaction.changes)
                    : decorations;
            }
            return buildCodeBlockDecorations(transaction.state);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}

export class InlineMathWidget extends WidgetType {
    private tex: string;

    constructor(tex: string) {
        super();
        this.tex = tex;
    }

    eq(other: InlineMathWidget) {
        return this.tex === other.tex;
    }

    toDOM() {
        const span = document.createElement("span");
        span.className = "cm-katex-inline";
        span.setAttribute("contenteditable", "false");
        try {
            katex.render(this.tex, span, {
                throwOnError: false,
                displayMode: false,
                output: "htmlAndMathml",
            });
        } catch {
            span.textContent = this.tex;
            span.classList.add("cm-katex-error");
        }
        return span;
    }

    ignoreEvent() {
        return true;
    }
}

class BlockMathWidget extends WidgetType {
    private tex: string;

    constructor(tex: string) {
        super();
        this.tex = tex;
    }

    eq(other: BlockMathWidget) {
        return this.tex === other.tex;
    }

    toDOM() {
        const div = document.createElement("div");
        div.className = "cm-katex-block";
        div.setAttribute("contenteditable", "false");
        try {
            katex.render(this.tex, div, {
                throwOnError: false,
                displayMode: true,
            });
        } catch {
            div.textContent = this.tex;
            div.classList.add("cm-katex-error");
        }
        return div;
    }

    ignoreEvent() {
        return true;
    }
}

const BLOCK_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

function buildBlockMathDecorations(state: EditorState): DecorationSet {
    const decos: DecoEntry[] = [];
    const text = state.doc.toString();

    BLOCK_MATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BLOCK_MATH_RE.exec(text)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        const tex = match[1].trim();

        if (!tex || !match[0].includes("\n")) continue;
        if (selectionTouchesRange(state, from, to)) continue;

        decos.push({
            from,
            to,
            deco: Decoration.replace({
                widget: new BlockMathWidget(tex),
                block: true,
                inclusive: false,
            }),
        });
    }

    decos.sort((a, b) => a.from - b.from || a.to - b.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to, deco } of decos) {
        builder.add(from, to, deco);
    }
    return builder.finish();
}

export function createBlockMathLivePreviewExtension() {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildBlockMathDecorations(state);
        },
        update(decorations, transaction) {
            if (!needsBlockRebuild(transaction)) {
                return transaction.docChanged
                    ? decorations.map(transaction.changes)
                    : decorations;
            }
            return buildBlockMathDecorations(transaction.state);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}

function countLeadingWhitespace(value: string): number {
    let count = 0;
    while (count < value.length && /\s/.test(value[count])) {
        count++;
    }
    return count;
}

function countTrailingWhitespace(value: string): number {
    let count = 0;
    while (count < value.length && /\s/.test(value[value.length - 1 - count])) {
        count++;
    }
    return count;
}

function parseTableRow(line: string, lineStart: number): ParsedTableRow {
    const separators: number[] = [];
    for (let index = 0; index < line.length; index++) {
        if (line[index] === "|" && line[index - 1] !== "\\") {
            separators.push(index);
        }
    }

    const rawSegments: Array<{ start: number; end: number; raw: string }> = [];
    let segmentStart = 0;
    for (const separator of separators) {
        rawSegments.push({
            start: segmentStart,
            end: separator,
            raw: line.slice(segmentStart, separator),
        });
        segmentStart = separator + 1;
    }
    rawSegments.push({
        start: segmentStart,
        end: line.length,
        raw: line.slice(segmentStart),
    });

    if (rawSegments.length > 1 && rawSegments[0]?.raw.trim() === "") {
        rawSegments.shift();
    }
    if (
        rawSegments.length > 1 &&
        rawSegments[rawSegments.length - 1]?.raw.trim() === ""
    ) {
        rawSegments.pop();
    }

    const cells = rawSegments.map(({ start, end, raw }) => {
        const leadingWhitespace = countLeadingWhitespace(raw);
        const trailingWhitespace = countTrailingWhitespace(raw);
        const trimmedStart = Math.min(start + leadingWhitespace, end);
        const trimmedEnd = Math.max(trimmedStart, end - trailingWhitespace);

        return {
            content: raw.trim(),
            from: lineStart + trimmedStart,
            to: lineStart + trimmedEnd,
        };
    });

    return {
        cells,
        lineEnd: lineStart + line.length,
    };
}

function splitSourceLines(source: string) {
    const lines = source.split(/\r?\n/);
    const result: Array<{ text: string; start: number }> = [];
    let offset = 0;

    for (const line of lines) {
        result.push({ text: line, start: offset });
        offset += line.length;

        if (source.startsWith("\r\n", offset)) {
            offset += 2;
        } else if (source.startsWith("\n", offset)) {
            offset += 1;
        }
    }

    return result;
}

function parseTableAlignment(cell: string): TableAlignment | null {
    const normalized = cell.trim();
    if (!/^:?-{3,}:?$/.test(normalized)) return null;
    const left = normalized.startsWith(":");
    const right = normalized.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
}

function padRow(row: string[], width: number): string[] {
    if (row.length >= width) return row;
    return [...row, ...Array.from({ length: width - row.length }, () => "")];
}

function padCellRow(row: ParsedTableRow, width: number): ParsedTableCell[] {
    if (row.cells.length >= width) return row.cells;
    return [
        ...row.cells,
        ...Array.from({ length: width - row.cells.length }, () => ({
            content: "",
            from: row.lineEnd,
            to: row.lineEnd,
        })),
    ];
}

function parseMarkdownTable(source: string) {
    const lines = splitSourceLines(source).filter(
        (line) => line.text.trim().length > 0,
    );

    if (lines.length < 2) return null;

    const header = parseTableRow(lines[0].text, lines[0].start);
    const delimiter = parseTableRow(lines[1].text, lines[1].start);
    if (
        !header.cells.length ||
        header.cells.length !== delimiter.cells.length
    ) {
        return null;
    }

    const alignments = delimiter.cells.map((cell) =>
        parseTableAlignment(cell.content),
    );
    if (alignments.some((alignment) => alignment === null)) {
        return null;
    }

    const body = lines
        .slice(2)
        .map((line) => parseTableRow(line.text, line.start));
    const columnCount = Math.max(
        header.cells.length,
        ...body.map((row) => row.cells.length),
    );

    return {
        header: padCellRow(header, columnCount),
        columnCount,
        alignments: padRow(
            alignments.map((alignment) => alignment ?? ""),
            columnCount,
        ).map((alignment) => (alignment || "left") as TableAlignment),
        rows: body.map((row) => padCellRow(row, columnCount)),
    };
}

function getInactiveAdjacentBlankLineRange(
    state: EditorState,
    from: number,
    to: number,
) {
    let replaceFrom = from;
    let replaceTo = to;

    const startLine = state.doc.lineAt(from);
    if (startLine.number > 1) {
        const previousLine = state.doc.line(startLine.number - 1);
        if (
            previousLine.text.trim().length === 0 &&
            !selectionTouchesLine(state, previousLine.from, previousLine.to)
        ) {
            replaceFrom = previousLine.from;
        }
    }

    const endLine = state.doc.lineAt(Math.max(from, to - 1));
    if (endLine.number < state.doc.lines) {
        const nextLine = state.doc.line(endLine.number + 1);
        if (
            nextLine.text.trim().length === 0 &&
            !selectionTouchesLine(state, nextLine.from, nextLine.to)
        ) {
            replaceTo = nextLine.to;
        }
    }

    return { from: replaceFrom, to: replaceTo };
}

function addInactiveAdjacentBlankLineDecorations(
    decos: DecoEntry[],
    state: EditorState,
    from: number,
    to: number,
) {
    const addIfInactiveBlank = (lineNumber: number) => {
        if (lineNumber < 1 || lineNumber > state.doc.lines) return;

        const line = state.doc.line(lineNumber);
        if (
            line.text.trim().length > 0 ||
            selectionTouchesLine(state, line.from, line.to)
        ) {
            return;
        }

        decos.push({
            from: line.from,
            to: line.from,
            deco: Decoration.line({ class: "cm-lp-block-gap-hidden" }),
        });
    };

    addIfInactiveBlank(state.doc.lineAt(from).number - 1);
    addIfInactiveBlank(state.doc.lineAt(Math.max(from, to - 1)).number + 1);
}

function createTableCell(
    tagName: "div",
    cellInfo: ParsedTableCell,
    sourceOffset: number,
    alignment: TableAlignment,
    interactions: TableInteractionHandlers,
) {
    const cell = document.createElement(tagName);
    cell.className = "cm-lp-table-cell";
    cell.dataset.sourceFrom = String(sourceOffset + cellInfo.from);
    cell.dataset.align = alignment;
    appendInteractiveTableContent(cell, cellInfo.content, interactions);
    return cell;
}

function trimUrlMatch(url: string) {
    return url.replace(/[.,;:!?)}\]'"]+$/g, "");
}

function appendInteractiveTableContent(
    parent: HTMLElement,
    content: string,
    interactions: TableInteractionHandlers,
) {
    let index = 0;

    while (index < content.length) {
        TABLE_WIKILINK_RE.lastIndex = index;
        TABLE_URL_RE.lastIndex = index;

        const wikilinkMatch = TABLE_WIKILINK_RE.exec(content);
        const urlMatch = TABLE_URL_RE.exec(content);
        const nextMatch = [wikilinkMatch, urlMatch]
            .filter((match): match is RegExpExecArray => match !== null)
            .sort((left, right) => left.index - right.index)[0];

        if (!nextMatch) {
            appendInlineTableFormatting(parent, content.slice(index));
            break;
        }

        if (nextMatch.index > index) {
            appendInlineTableFormatting(
                parent,
                content.slice(index, nextMatch.index),
            );
        }

        if (nextMatch === wikilinkMatch) {
            const inner = nextMatch[1];
            const pipeIndex = inner.indexOf("|");
            const target =
                pipeIndex >= 0
                    ? inner.slice(0, pipeIndex).trim()
                    : inner.trim();
            const label =
                pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : target;
            const link = document.createElement("span");
            link.className = interactions.resolveWikilink(target)
                ? "cm-lp-table-link cm-lp-table-wikilink cm-lp-table-wikilink-valid"
                : "cm-lp-table-link cm-lp-table-wikilink cm-lp-table-wikilink-broken";
            link.dataset.wikilinkTarget = target;
            link.textContent = label || target;
            link.tabIndex = 0;
            link.setAttribute("role", "link");
            parent.appendChild(link);
        } else {
            const url = trimUrlMatch(nextMatch[0]);
            const link = document.createElement("span");
            link.className = "cm-lp-table-link cm-lp-table-url";
            link.dataset.url = url;
            link.textContent = url;
            link.tabIndex = 0;
            link.setAttribute("role", "link");
            parent.appendChild(link);
        }

        index =
            nextMatch.index +
            (nextMatch === wikilinkMatch
                ? nextMatch[0].length
                : trimUrlMatch(nextMatch[0]).length);
    }
}

function appendInlineTableFormatting(parent: HTMLElement, content: string) {
    let index = 0;
    const highlightRanges = findHighlightRanges(content);
    let highlightIndex = 0;

    while (index < content.length) {
        TABLE_BOLD_RE.lastIndex = index;

        const boldMatch = TABLE_BOLD_RE.exec(content);
        const highlightRange = highlightRanges[highlightIndex] ?? null;

        const nextHighlightIndex =
            highlightRange && highlightRange.from >= index
                ? highlightRange.from
                : Number.POSITIVE_INFINITY;
        const nextBoldIndex = boldMatch?.index ?? Number.POSITIVE_INFINITY;

        if (
            nextBoldIndex === Number.POSITIVE_INFINITY &&
            nextHighlightIndex === Number.POSITIVE_INFINITY
        ) {
            parent.appendChild(document.createTextNode(content.slice(index)));
            break;
        }

        if (nextHighlightIndex < nextBoldIndex) {
            if (nextHighlightIndex > index) {
                parent.appendChild(
                    document.createTextNode(
                        content.slice(index, nextHighlightIndex),
                    ),
                );
            }

            const span = document.createElement("span");
            span.className = "cm-lp-table-highlight";
            span.textContent = content.slice(
                highlightRange!.contentFrom,
                highlightRange!.contentTo,
            );
            parent.appendChild(span);

            index = highlightRange!.to;
            highlightIndex++;
            continue;
        }

        if (!boldMatch) {
            parent.appendChild(document.createTextNode(content.slice(index)));
            break;
        }

        if (boldMatch.index > index) {
            parent.appendChild(
                document.createTextNode(content.slice(index, boldMatch.index)),
            );
        }

        const span = document.createElement("span");
        span.className = "cm-lp-table-bold";
        span.textContent = boldMatch[1];
        parent.appendChild(span);

        index = boldMatch.index + boldMatch[0].length;
    }
}

class TableWidget extends WidgetType {
    private source: string;
    private from: number;
    private to: number;
    private interactions: TableInteractionHandlers;

    constructor(
        source: string,
        from: number,
        to: number,
        interactions: TableInteractionHandlers,
    ) {
        super();
        this.source = source;
        this.from = from;
        this.to = to;
        this.interactions = interactions;
    }

    eq(other: TableWidget) {
        return this.source === other.source && this.from === other.from;
    }

    toDOM() {
        const parsed = parseMarkdownTable(this.source);
        const wrapper = document.createElement("div");
        wrapper.className = "cm-lp-table-widget";
        wrapper.dataset.sourceFrom = String(this.from);
        wrapper.dataset.sourceTo = String(this.to);
        wrapper.setAttribute("contenteditable", "false");

        if (!parsed) {
            const fallback = document.createElement("pre");
            fallback.className = "cm-lp-table-fallback";
            fallback.textContent = this.source;
            wrapper.appendChild(fallback);
            return wrapper;
        }

        const table = document.createElement("div");
        table.className = "cm-lp-table";
        table.style.setProperty(
            "--cm-lp-table-columns",
            String(parsed.columnCount),
        );

        const headerRow = document.createElement("div");
        headerRow.className = "cm-lp-table-row cm-lp-table-row-header";
        parsed.header.forEach((cellInfo, index) => {
            headerRow.appendChild(
                createTableCell(
                    "div",
                    cellInfo,
                    this.from,
                    parsed.alignments[index],
                    this.interactions,
                ),
            );
        });
        table.appendChild(headerRow);

        parsed.rows.forEach((row) => {
            const tr = document.createElement("div");
            tr.className = "cm-lp-table-row";
            row.forEach((cellInfo, index) => {
                tr.appendChild(
                    createTableCell(
                        "div",
                        cellInfo,
                        this.from,
                        parsed.alignments[index],
                        this.interactions,
                    ),
                );
            });
            table.appendChild(tr);
        });

        wrapper.appendChild(table);
        return wrapper;
    }

    ignoreEvent() {
        return true;
    }
}

function resolveImageUrl(
    rawUrl: string,
    vaultRoot: string | null,
    notePath: string | null,
): string | null {
    const resolved = resolvePreviewAssetPath(rawUrl, vaultRoot, notePath);
    if (
        resolved.startsWith("http://") ||
        resolved.startsWith("https://") ||
        resolved.startsWith("data:") ||
        resolved.startsWith("file://")
    ) {
        return resolved;
    }
    return buildVaultPreviewUrlFromAbsolutePath(resolved, vaultRoot);
}

function truncateInlineImageLabel(value: string, maxLength = 160): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
}

function isSuspiciousRemoteImageUrl(url: string): boolean {
    return (
        (url.startsWith("http://") || url.startsWith("https://")) &&
        url.length > MAX_REMOTE_IMAGE_URL_LENGTH
    );
}

function isRenderableImageUrl(url: string): boolean {
    return (
        url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.startsWith("data:image/") ||
        IMAGE_EXTENSIONS.test(url)
    );
}

function parseWikilinkEmbedTarget(
    raw: string,
): { target: string; heading?: string; width?: number } | null {
    if (!raw.startsWith("![[") || !raw.endsWith("]]")) return null;

    let inner = raw.slice(3, -2).trim();
    if (!inner) return null;

    let width: number | undefined;
    const widthSeparator = inner.lastIndexOf("|");
    if (widthSeparator >= 0) {
        const dimStr = inner.slice(widthSeparator + 1).trim();
        const dimMatch = dimStr.match(/^(\d+)(?:x\d+)?$/);
        if (dimMatch) {
            width = Number(dimMatch[1]);
            inner = inner.slice(0, widthSeparator).trim();
        }
    }

    if (!inner) return null;

    const hashIdx = inner.indexOf("#");
    if (hashIdx >= 0) {
        return {
            target: inner.slice(0, hashIdx),
            heading: inner.slice(hashIdx + 1),
            width,
        };
    }
    return { target: inner, width };
}

function isStandaloneLinkNode(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    const startLine = state.doc.lineAt(from);
    const endLine = state.doc.lineAt(Math.max(from, to - 1));
    if (startLine.number !== endLine.number) return false;

    const before = state.doc.sliceString(startLine.from, from);
    const after = state.doc.sliceString(to, startLine.to);
    return before.trim().length === 0 && after.trim().length === 0;
}

function findStandaloneUrlLineRange(
    state: EditorState,
    lineNumber: number,
): { from: number; to: number; href: string } | null {
    const line = state.doc.line(lineNumber);
    const trimmed = line.text.trim();
    if (!trimmed || !STANDALONE_URL_RE.test(trimmed)) {
        return null;
    }

    const href = trimmed.replace(/[.,;:!?)}\]'"]+$/g, "");
    if (!href || href !== trimmed || !extractYouTubeVideoId(href)) {
        return null;
    }

    const leadingWhitespace = line.text.length - line.text.trimStart().length;
    return {
        from: line.from + leadingWhitespace,
        to: line.from + leadingWhitespace + href.length,
        href,
    };
}

function hasOverlappingDecoration(
    decos: DecoEntry[],
    from: number,
    to: number,
): boolean {
    return decos.some((entry) => entry.from < to && entry.to > from);
}

function buildBlockDecorations(
    state: EditorState,
    vaultRoot: string | null,
): DecorationSet {
    const decos: DecoEntry[] = [];
    const linkReferences = state.field(linkReferenceField);
    const activeNotePath = getActiveNotePath();

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name === "Link" || node.name === "Autolink") {
                if (selectionTouchesRange(state, node.from, node.to)) return;
                if (!isStandaloneLinkNode(state, node.from, node.to)) return;

                const info = parseLinkChildren(node.node, state);
                if (!info) return;

                const href = resolveLinkHref(info, linkReferences);
                if (!href || !extractYouTubeVideoId(href)) return;

                const label =
                    state.doc.sliceString(info.textFrom, info.textTo).trim() ||
                    info.title ||
                    "YouTube video";

                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: new YouTubeWidget(
                            href,
                            label,
                            node.from,
                            node.to,
                        ),
                        block: true,
                        inclusive: false,
                    }),
                });
                return;
            }

            if (node.name !== "Image") return;

            const raw = state.doc.sliceString(node.from, node.to);
            const embedParsed = parseWikilinkEmbedTarget(raw);
            if (embedParsed) {
                if (selectionTouchesRange(state, node.from, node.to)) return;
                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: IMAGE_EXTENSIONS.test(embedParsed.target)
                            ? (() => {
                                  const resolvedUrl = resolveImageUrl(
                                      embedParsed.target,
                                      vaultRoot,
                                      activeNotePath,
                                  );
                                  const resolvedPath = resolvePreviewAssetPath(
                                      embedParsed.target,
                                      vaultRoot,
                                      activeNotePath,
                                  );

                                  if (!resolvedUrl) {
                                      return new SkippedImageWidget(
                                          "Local image preview blocked: file is outside the active vault.",
                                          node.from,
                                          node.to,
                                      );
                                  }

                                  return new ImageWidget(
                                      resolvedUrl,
                                      embedParsed.target,
                                      node.from,
                                      node.to,
                                      null,
                                      null,
                                      embedParsed.width ?? null,
                                      true,
                                      isAuthorizedVaultPreviewPath(
                                          resolvedPath,
                                          vaultRoot,
                                      ),
                                  );
                              })()
                            : PDF_EXTENSION.test(embedParsed.target)
                              ? new PdfEmbedWidget(
                                    embedParsed.target.split("/").pop() ??
                                        embedParsed.target,
                                    embedParsed.target,
                                    node.from,
                                    node.to,
                                    isAuthorizedVaultPreviewPath(
                                        resolvePreviewAssetPath(
                                            embedParsed.target,
                                            vaultRoot,
                                            activeNotePath,
                                        ),
                                        vaultRoot,
                                    ),
                                )
                              : new NoteEmbedWidget(
                                    embedParsed.target,
                                    node.from,
                                    node.to,
                                    embedParsed.heading,
                                ),
                        block: true,
                        inclusive: false,
                    }),
                });
                return;
            }

            const info = parseLinkChildren(node.node, state);
            if (!info) {
                return;
            }
            const resolvedImageHref = resolveLinkHref(info, linkReferences);
            if (!resolvedImageHref) {
                return;
            }
            if (selectionTouchesRange(state, node.from, node.to)) return;

            const altText = state.doc.sliceString(info.textFrom, info.textTo);
            const youtubeVideoId = extractYouTubeVideoId(resolvedImageHref);
            const parentLink = findAncestor(node.node.parent, "Link");
            const outerLinkInfo = parentLink
                ? parseLinkChildren(parentLink, state)
                : null;
            const href = outerLinkInfo
                ? resolveLinkHref(outerLinkInfo, linkReferences)
                : null;

            if (youtubeVideoId) {
                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: new YouTubeWidget(
                            resolvedImageHref,
                            altText || "YouTube video",
                            node.from,
                            node.to,
                        ),
                        block: true,
                        inclusive: false,
                    }),
                });
                return;
            }

            if (!isRenderableImageUrl(resolvedImageHref)) {
                return;
            }

            if (isSuspiciousRemoteImageUrl(resolvedImageHref)) {
                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: new SkippedImageWidget(
                            "Image preview skipped: URL too long",
                            node.from,
                            node.to,
                        ),
                        block: false,
                    }),
                });
                return;
            }

            const resolvedUrl = resolveImageUrl(
                resolvedImageHref,
                vaultRoot,
                activeNotePath,
            );

            if (!resolvedUrl) {
                decos.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                        widget: new SkippedImageWidget(
                            "Local image preview blocked: file is outside the active vault.",
                            node.from,
                            node.to,
                        ),
                        block: false,
                    }),
                });
                return;
            }

            decos.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({
                    widget: new ImageWidget(
                        resolvedUrl,
                        altText,
                        node.from,
                        node.to,
                        href,
                        info.title ??
                            (info.label
                                ? (linkReferences.get(
                                      normalizeReferenceLabel(info.label),
                                  )?.title ?? null)
                                : null),
                    ),
                    block: false,
                }),
            });
        },
    });

    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
        const standaloneUrl = findStandaloneUrlLineRange(state, lineNumber);
        if (!standaloneUrl) continue;
        if (
            selectionTouchesRange(state, standaloneUrl.from, standaloneUrl.to)
        ) {
            continue;
        }
        if (
            hasOverlappingDecoration(
                decos,
                standaloneUrl.from,
                standaloneUrl.to,
            )
        ) {
            continue;
        }

        decos.push({
            from: standaloneUrl.from,
            to: standaloneUrl.to,
            deco: Decoration.replace({
                widget: new YouTubeWidget(
                    standaloneUrl.href,
                    "YouTube video",
                    standaloneUrl.from,
                    standaloneUrl.to,
                ),
                block: true,
                inclusive: false,
            }),
        });
    }

    decos.sort((left, right) => left.from - right.from || left.to - right.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return builder.finish();
}

function buildTableDecorations(
    state: EditorState,
    interactions: TableInteractionHandlers,
): DecorationSet {
    const decos: DecoEntry[] = [];

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== "Table") return;
            if (selectionTouchesRange(state, node.from, node.to)) {
                return false;
            }

            const source = state.doc.sliceString(node.from, node.to);
            // CodeMirror keeps visual line boxes for inactive blank lines around
            // block widgets unless the replacement range and line styling both
            // account for them.
            const replacementRange = getInactiveAdjacentBlankLineRange(
                state,
                node.from,
                node.to,
            );
            addInactiveAdjacentBlankLineDecorations(
                decos,
                state,
                node.from,
                node.to,
            );
            decos.push({
                from: replacementRange.from,
                to: replacementRange.to,
                deco: Decoration.replace({
                    widget: new TableWidget(
                        source,
                        node.from,
                        node.to,
                        interactions,
                    ),
                    block: true,
                    inclusive: false,
                }),
            });
            return false;
        },
    });

    decos.sort((left, right) => left.from - right.from || left.to - right.to);

    const builder = new RangeSetBuilder<Decoration>();
    for (const deco of decos) {
        builder.add(deco.from, deco.to, deco.deco);
    }
    return builder.finish();
}

export function createImageResizeExtension(): Extension {
    return ViewPlugin.define((view) => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as {
                from: number;
                to: number;
                width: number | null;
            };
            const oldText = view.state.doc.sliceString(detail.from, detail.to);
            const newText = buildResizedWikilink(oldText, detail.width);
            if (newText !== oldText) {
                view.dispatch({
                    changes: {
                        from: detail.from,
                        to: detail.to,
                        insert: newText,
                    },
                });
            }
        };
        view.dom.addEventListener("cm-image-resize", handler);
        return {
            destroy() {
                view.dom.removeEventListener("cm-image-resize", handler);
            },
        };
    });
}

export function createImageLivePreviewExtension(vaultRoot: string | null) {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildBlockDecorations(state, vaultRoot);
        },
        update(decorations, transaction) {
            if (!needsSyntaxBackedBlockRebuild(transaction)) {
                return transaction.docChanged
                    ? decorations.map(transaction.changes)
                    : decorations;
            }
            return buildBlockDecorations(transaction.state, vaultRoot);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}

export function createTableLivePreviewExtension(
    interactions: TableInteractionHandlers,
) {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildTableDecorations(state, interactions);
        },
        update(decorations, transaction) {
            if (!needsSyntaxBackedBlockRebuild(transaction)) {
                return transaction.docChanged
                    ? decorations.map(transaction.changes)
                    : decorations;
            }
            return buildTableDecorations(transaction.state, interactions);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}
