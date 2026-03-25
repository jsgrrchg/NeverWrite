import Defuddle from "defuddle/full";
import type { DefuddleResponse } from "defuddle/full";
import type { ClipMetadata, ClipSelection } from "./clipper-contract";

export interface ExtractedClipSource {
    metadata: ClipMetadata;
    contentHtml: string;
    selection: Omit<ClipSelection, "markdown"> | null;
    wordCount: number;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
    for (const value of values) {
        const normalized = value?.trim();
        if (normalized) {
            return normalized;
        }
    }

    return "";
}

function readMetaContent(document: Document, selectors: string[]): string {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) {
            continue;
        }

        const content =
            element.getAttribute("content") ??
            element.getAttribute("href") ??
            element.textContent;
        const normalized = content?.trim();
        if (normalized) {
            return normalized;
        }
    }

    return "";
}

function readTextContent(document: Document, selectors: string[]): string {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        const normalized = element?.textContent?.trim();
        if (normalized) {
            return normalized;
        }
    }

    return "";
}

function cloneDocument(source: Document): Document {
    return new DOMParser().parseFromString(
        source.documentElement.outerHTML,
        "text/html",
    );
}

function countWordsFromHtml(html: string): number {
    if (!html.trim()) {
        return 0;
    }

    const parsed = new DOMParser().parseFromString(html, "text/html");
    const text = parsed.body.textContent?.trim() ?? "";
    return text ? text.split(/\s+/).length : 0;
}

function extractSelection(
    sourceDocument: Document,
    sourceWindow: Window,
): Omit<ClipSelection, "markdown"> | null {
    const selection = sourceWindow.getSelection();
    if (!selection || selection.isCollapsed) {
        return null;
    }

    const text = selection.toString().trim();
    if (!text) {
        return null;
    }

    const htmlParts: string[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        const container = sourceDocument.createElement("div");
        container.append(range.cloneContents());
        const html = container.innerHTML.trim();
        if (html) {
            htmlParts.push(html);
        }
    }

    return {
        text,
        html: htmlParts.join("\n").trim(),
    };
}

function extractFallbackContentHtml(document: Document): string {
    const selectors = [
        "article",
        "main",
        "[role='main']",
        ".article-body",
        ".entry-content",
        ".post-content",
        ".markdown-body",
        "body",
    ];

    for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        const html = element?.innerHTML?.trim();
        if (html) {
            return html;
        }
    }

    return "";
}

function extractMetadata(
    sourceDocument: Document,
    parsed: DefuddleResponse,
): ClipMetadata {
    const currentUrl = new URL(sourceDocument.URL);
    const manualTitle = firstNonEmpty(
        readMetaContent(sourceDocument, [
            "meta[property='og:title']",
            "meta[name='twitter:title']",
        ]),
        sourceDocument.title,
        readTextContent(sourceDocument, ["h1"]),
    );

    return {
        title: firstNonEmpty(manualTitle, parsed.title),
        url: sourceDocument.URL,
        domain: firstNonEmpty(currentUrl.hostname, parsed.domain),
        description: firstNonEmpty(
            readMetaContent(sourceDocument, [
                "meta[name='description']",
                "meta[property='og:description']",
                "meta[name='twitter:description']",
            ]),
            parsed.description,
        ),
        author: firstNonEmpty(
            readMetaContent(sourceDocument, [
                "meta[name='author']",
                "meta[property='author']",
                "meta[property='article:author']",
            ]),
            readTextContent(sourceDocument, [
                "[itemprop='author']",
                "[rel='author']",
            ]),
            parsed.author,
        ),
        published: firstNonEmpty(
            readMetaContent(sourceDocument, [
                "meta[property='article:published_time']",
                "meta[name='publication_date']",
                "meta[name='date']",
                "meta[itemprop='datePublished']",
            ]),
            sourceDocument.querySelector("time")?.getAttribute("datetime") ?? "",
            parsed.published,
        ),
        image: firstNonEmpty(
            readMetaContent(sourceDocument, [
                "meta[property='og:image']",
                "meta[name='twitter:image']",
                "meta[itemprop='image']",
            ]),
            parsed.image,
        ),
        favicon: firstNonEmpty(
            readMetaContent(sourceDocument, [
                "link[rel='icon']",
                "link[rel='shortcut icon']",
                "link[rel='apple-touch-icon']",
            ]),
            parsed.favicon,
        ),
        language: firstNonEmpty(
            sourceDocument.documentElement.lang,
            readMetaContent(sourceDocument, [
                "meta[property='og:locale']",
                "meta[http-equiv='content-language']",
            ]),
            parsed.language,
        ),
    };
}

export function extractClipSource(
    sourceDocument: Document = document,
    sourceWindow: Window = window,
): ExtractedClipSource {
    const clonedDocument = cloneDocument(sourceDocument);
    const defuddle = new Defuddle(clonedDocument, {
        url: sourceDocument.URL,
        useAsync: false,
    });
    const parsed = defuddle.parse();

    const contentHtml = firstNonEmpty(
        parsed.content,
        extractFallbackContentHtml(sourceDocument),
    );
    const metadata = extractMetadata(sourceDocument, parsed);

    return {
        metadata,
        contentHtml,
        selection: extractSelection(sourceDocument, sourceWindow),
        wordCount: parsed.wordCount || countWordsFromHtml(contentHtml),
    };
}
