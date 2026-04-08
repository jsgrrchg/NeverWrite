export const OPEN_YOUTUBE_MODAL_EVENT = "neverwrite:open-youtube-modal";

export interface OpenYouTubeModalPayload {
    href: string;
    title: string;
}

export interface YouTubePreviewData {
    title: string | null;
    thumbnailUrl: string | null;
}

const YOUTUBE_PREVIEW_CACHE_LIMIT = 128;
const previewCache = new Map<string, Promise<YouTubePreviewData>>();
const YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
]);
const YOUTUBE_EMBED_HOSTS = new Set(["youtube-nocookie.com"]);

function rememberPreviewRequest(
    url: string,
    request: Promise<YouTubePreviewData>,
) {
    if (previewCache.has(url)) {
        previewCache.delete(url);
    }
    previewCache.set(url, request);

    while (previewCache.size > YOUTUBE_PREVIEW_CACHE_LIMIT) {
        const oldestKey = previewCache.keys().next().value;
        if (oldestKey === undefined) break;
        previewCache.delete(oldestKey);
    }
}

export function extractYouTubeVideoId(url: string): string | null {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

        if (host === "youtu.be") {
            const id = parsed.pathname.split("/").filter(Boolean)[0];
            return id || null;
        }

        if (YOUTUBE_HOSTS.has(host) || YOUTUBE_EMBED_HOSTS.has(host)) {
            if (parsed.pathname === "/watch") {
                return parsed.searchParams.get("v");
            }

            const segments = parsed.pathname.split("/").filter(Boolean);
            if (
                segments[0] === "embed" ||
                segments[0] === "shorts" ||
                segments[0] === "live"
            ) {
                return segments[1] ?? null;
            }
        }
    } catch {
        return null;
    }

    return null;
}

export function getYouTubeEmbedUrl(url: string): string | null {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return null;

    const params = new URLSearchParams({
        autoplay: "1",
        rel: "0",
        modestbranding: "1",
        playsinline: "1",
    });

    return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

export function getYouTubeThumbnailUrl(url: string): string | null {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return null;
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function getYouTubePreview(url: string): Promise<YouTubePreviewData> {
    const cached = previewCache.get(url);
    if (cached) return cached;

    const fallbackThumbnailUrl = getYouTubeThumbnailUrl(url);
    const request = fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    )
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(`oEmbed request failed: ${response.status}`);
            }

            const payload = (await response.json()) as {
                title?: unknown;
                thumbnail_url?: unknown;
            };

            return {
                title: typeof payload.title === "string" ? payload.title : null,
                thumbnailUrl:
                    typeof payload.thumbnail_url === "string"
                        ? payload.thumbnail_url
                        : fallbackThumbnailUrl,
            } satisfies YouTubePreviewData;
        })
        .catch(() => ({
            title: null,
            thumbnailUrl: fallbackThumbnailUrl,
        }));

    rememberPreviewRequest(url, request);
    return request;
}

export function dispatchOpenYouTubeModal(payload: OpenYouTubeModalPayload) {
    window.dispatchEvent(
        new CustomEvent<OpenYouTubeModalPayload>(OPEN_YOUTUBE_MODAL_EVENT, {
            detail: payload,
        }),
    );
}
