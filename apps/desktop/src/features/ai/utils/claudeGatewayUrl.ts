const INVALID_GATEWAY_URL_MESSAGE = "Enter a valid gateway URL.";
const GATEWAY_HTTPS_REQUIRED_MESSAGE = "Gateway URL must use HTTPS.";
const GATEWAY_LOCAL_HTTP_ONLY_MESSAGE =
    "HTTP gateways are only allowed for localhost.";
const GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE =
    "Gateway URL must not include embedded credentials.";

export function getClaudeGatewayUrlValidationMessage(
    raw: string,
): string | null {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return INVALID_GATEWAY_URL_MESSAGE;
    }

    if (parsed.username || parsed.password) {
        return GATEWAY_EMBEDDED_CREDENTIALS_MESSAGE;
    }

    if (!parsed.hostname) {
        return INVALID_GATEWAY_URL_MESSAGE;
    }

    if (parsed.protocol === "https:") {
        return null;
    }

    if (parsed.protocol !== "http:") {
        return GATEWAY_HTTPS_REQUIRED_MESSAGE;
    }

    return isLoopbackGatewayHostname(parsed.hostname)
        ? null
        : GATEWAY_LOCAL_HTTP_ONLY_MESSAGE;
}

function isLoopbackGatewayHostname(hostname: string): boolean {
    const normalized = hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase();

    if (normalized === "localhost" || normalized.endsWith(".localhost")) {
        return true;
    }

    return isLoopbackIpv4(normalized) || normalized === "::1";
}

function isLoopbackIpv4(hostname: string): boolean {
    const parts = hostname.split(".");
    if (parts.length !== 4) {
        return false;
    }

    const octets = parts.map((part) => Number(part));
    if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        return false;
    }

    return octets[0] === 127;
}
