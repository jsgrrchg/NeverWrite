import { toVaultRelativePath } from "./vaultPaths";

const FILE_PREVIEW_SCHEME = "vaultai-file://localhost";

function encodeBase64Url(value: string) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function splitPathSuffix(value: string) {
    const marker = value.search(/[?#]/);
    return marker === -1
        ? { pathname: value, suffix: "" }
        : {
              pathname: value.slice(0, marker),
              suffix: value.slice(marker),
          };
}

export function buildVaultPreviewUrl(
    vaultPath: string | null,
    relativePath: string,
) {
    if (!vaultPath) {
        return null;
    }

    return `${FILE_PREVIEW_SCHEME}/vault/${encodeBase64Url(vaultPath)}/${encodeBase64Url(relativePath)}`;
}

export function buildVaultPreviewUrlFromAbsolutePath(
    absolutePath: string,
    vaultPath: string | null,
) {
    const { pathname, suffix } = splitPathSuffix(absolutePath);
    const relativePath = toVaultRelativePath(pathname, vaultPath);
    if (!relativePath) {
        return null;
    }

    const previewUrl = buildVaultPreviewUrl(vaultPath, relativePath);
    return previewUrl ? `${previewUrl}${suffix}` : null;
}

export function isAuthorizedVaultPreviewPath(
    absolutePath: string,
    vaultPath: string | null,
) {
    const { pathname } = splitPathSuffix(absolutePath);
    return toVaultRelativePath(pathname, vaultPath) ? pathname : null;
}
