import DOMPurify from "dompurify";

const SANITIZER_CONFIG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["iframe", "noscript", "script", "style"],
    RETURN_TRUSTED_TYPE: false,
};

export function sanitizeHtml(html: string): string {
    const normalized = html.trim();
    if (!normalized) {
        return "";
    }

    return DOMPurify.sanitize(normalized, SANITIZER_CONFIG);
}
