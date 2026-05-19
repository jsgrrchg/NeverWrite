const YOUTUBE_EMBED_REFERER = "https://neverwrite.localhost/";
const YOUTUBE_EMBED_URLS = [
    "https://www.youtube.com/embed/*",
    "https://www.youtube-nocookie.com/embed/*",
];

type RequestHeaders = Record<string, string>;

interface BeforeSendHeadersDetails {
    url: string;
    requestHeaders: RequestHeaders;
}

type BeforeSendHeadersCallback = (response: {
    requestHeaders: RequestHeaders;
}) => void;

interface HeaderInstallingSession {
    webRequest: {
        onBeforeSendHeaders: (
            filter: { urls: string[] },
            listener: (
                details: BeforeSendHeadersDetails,
                callback: BeforeSendHeadersCallback,
            ) => void,
        ) => void;
    };
}

function findHeaderKey(headers: RequestHeaders, name: string) {
    const normalizedName = name.toLowerCase();
    return Object.keys(headers).find(
        (key) => key.toLowerCase() === normalizedName,
    );
}

export function withYouTubeEmbedIdentityHeaders(
    headers: RequestHeaders,
): RequestHeaders {
    const refererKey = findHeaderKey(headers, "referer");
    if (refererKey && headers[refererKey]?.trim()) {
        return headers;
    }

    return {
        ...headers,
        [refererKey ?? "Referer"]: YOUTUBE_EMBED_REFERER,
    };
}

export function installYouTubeEmbedIdentityHeaders(
    targetSession: HeaderInstallingSession,
) {
    targetSession.webRequest.onBeforeSendHeaders(
        { urls: YOUTUBE_EMBED_URLS },
        (details, callback) => {
            callback({
                requestHeaders: withYouTubeEmbedIdentityHeaders(
                    details.requestHeaders,
                ),
            });
        },
    );
}
