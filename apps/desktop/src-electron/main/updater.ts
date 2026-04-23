import { app } from "electron";
import {
    MacUpdater,
    NsisUpdater,
    type AppUpdater,
    type UpdateInfo,
} from "electron-updater";

type UpdaterRuntimeMode = "production" | "non-production";

export interface AvailableAppUpdateDto {
    body: string | null;
    currentVersion: string;
    version: string;
    date: string | null;
    target: string;
    downloadUrl: string;
    rawJson: unknown;
}

export interface AppUpdateStatusDto {
    enabled: boolean;
    currentVersion: string;
    channel: string;
    endpoint: string | null;
    message: string | null;
    update: AvailableAppUpdateDto | null;
}

interface UpdaterRuntimeConfig {
    channel: string;
    runtimeMode: UpdaterRuntimeMode;
    endpoint: URL | null;
    endpointDisplay: string | null;
    endpointError: string | null;
    feedDirectoryUrl: string | null;
    feedTarget: string | null;
    metadataFileName: string | null;
    allowedFeedHosts: string[];
    allowedDownloadHosts: string[];
    allowProdEndpointsInNonProd: boolean;
}

interface LoggerLike {
    info(message?: unknown): void;
    warn(message?: unknown): void;
    error(message?: unknown): void;
    debug?(message?: string): void;
}

const UPDATER_ENDPOINT_ENV_VARS = ["NEVERWRITE_UPDATER_ENDPOINT"];
const UPDATER_BASE_URL_ENV_VARS = ["NEVERWRITE_UPDATER_BASE_URL"];
const UPDATER_CHANNEL_ENV_VARS = ["NEVERWRITE_UPDATER_CHANNEL"];
const UPDATER_ALLOWED_FEED_HOSTS_ENV_VARS = [
    "NEVERWRITE_UPDATER_ALLOWED_FEED_HOSTS",
];
const UPDATER_ALLOWED_DOWNLOAD_HOSTS_ENV_VARS = [
    "NEVERWRITE_UPDATER_ALLOWED_DOWNLOAD_HOSTS",
];
const UPDATER_ALLOW_PROD_ENDPOINTS_IN_NON_PROD_ENV_VARS = [
    "NEVERWRITE_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD",
];

function readFirstNonEmptyEnv(keys: readonly string[]) {
    for (const key of keys) {
        const value = process.env[key]?.trim();
        if (value) {
            return value;
        }
    }
    return null;
}

function readEnvFlag(keys: readonly string[]) {
    const value = readFirstNonEmptyEnv(keys);
    return value
        ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
        : false;
}

function readCsvEnv(keys: readonly string[]) {
    const value = readFirstNonEmptyEnv(keys);
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map((item) => item.trim().replace(/\.+$/, "").toLowerCase())
        .filter(Boolean);
}

function isLoopbackHost(host: string) {
    const normalized = host.trim().replace(/\.+$/, "").toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hostMatchesAllowlist(host: string, allowlist: readonly string[]) {
    const normalizedHost = host.trim().replace(/\.+$/, "").toLowerCase();
    return allowlist.some(
        (allowedHost) =>
            normalizedHost === allowedHost ||
            normalizedHost.endsWith(`.${allowedHost}`),
    );
}

function validateUrlCommon(url: URL, label: string) {
    if (url.username || url.password) {
        throw new Error(`${label} must not contain embedded credentials: ${url}`);
    }
    if (url.search) {
        throw new Error(`${label} must not contain query parameters: ${url}`);
    }
    if (url.hash) {
        throw new Error(`${label} must not contain fragments: ${url}`);
    }
}

function validateProductionFeedHost(url: URL, allowedFeedHosts: readonly string[]) {
    const host = url.hostname;
    if (!host) {
        throw new Error(
            `Updater endpoint must include a hostname in production: ${url}`,
        );
    }

    if (allowedFeedHosts.length > 0) {
        if (!hostMatchesAllowlist(host, allowedFeedHosts)) {
            throw new Error(
                `Updater endpoint host '${host}' is not in NEVERWRITE_UPDATER_ALLOWED_FEED_HOSTS.`,
            );
        }
        return;
    }

    if (!host.toLowerCase().endsWith(".github.io")) {
        throw new Error(
            `Updater endpoint host '${host}' is not allowed. Production default only permits GitHub Pages hosts (*.github.io).`,
        );
    }
}

function validateProductionDownloadHost(
    url: URL,
    allowedDownloadHosts: readonly string[],
) {
    const host = url.hostname;
    if (!host) {
        throw new Error(
            `Updater download URL must include a hostname in production: ${url}`,
        );
    }

    if (allowedDownloadHosts.length > 0) {
        if (!hostMatchesAllowlist(host, allowedDownloadHosts)) {
            throw new Error(
                `Updater download host '${host}' is not in NEVERWRITE_UPDATER_ALLOWED_DOWNLOAD_HOSTS.`,
            );
        }
        return;
    }

    if (host.toLowerCase() !== "github.com") {
        throw new Error(
            `Updater download host '${host}' is not allowed. Production default only permits github.com release URLs.`,
        );
    }
}

function validateUpdaterEndpointUrl(
    url: URL,
    runtimeMode: UpdaterRuntimeMode,
    allowProdEndpointsInNonProd: boolean,
    allowedFeedHosts: readonly string[],
) {
    validateUrlCommon(url, "Updater endpoint");

    const productionRulesApply =
        runtimeMode === "production" || allowProdEndpointsInNonProd;

    if (productionRulesApply) {
        if (url.protocol !== "https:") {
            throw new Error(
                `Updater endpoint must use https in production-like mode: ${url}`,
            );
        }
        validateProductionFeedHost(url, allowedFeedHosts);
        return;
    }

    if (url.protocol === "file:") {
        return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
            `Unsupported updater endpoint scheme '${url.protocol.replace(/:$/, "")}': ${url}`,
        );
    }

    if (!isLoopbackHost(url.hostname)) {
        throw new Error(
            `Non-production updater endpoint must stay local (loopback or file URL). Refusing public feed: ${url}. Set NEVERWRITE_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD=true only for explicit one-off validation.`,
        );
    }
}

function validateUpdateDownloadUrl(
    url: URL,
    runtimeMode: UpdaterRuntimeMode,
    allowProdEndpointsInNonProd: boolean,
    allowedDownloadHosts: readonly string[],
) {
    validateUrlCommon(url, "Updater download URL");

    const productionRulesApply =
        runtimeMode === "production" || allowProdEndpointsInNonProd;

    if (productionRulesApply) {
        if (url.protocol !== "https:") {
            throw new Error(
                `Updater download URL must use https in production-like mode: ${url}`,
            );
        }
        validateProductionDownloadHost(url, allowedDownloadHosts);
        return;
    }

    if (url.protocol === "file:") {
        return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(
            `Unsupported updater download scheme '${url.protocol.replace(/:$/, "")}': ${url}`,
        );
    }

    if (!isLoopbackHost(url.hostname)) {
        throw new Error(
            `Non-production updater download URL must stay local (loopback or file URL). Refusing public asset URL: ${url}. Set NEVERWRITE_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD=true only for explicit one-off validation.`,
        );
    }
}

function normalizeUpdaterChannel(value: string | null) {
    return value?.trim().toLowerCase() || "stable";
}

function currentUpdaterRuntimeMode(): UpdaterRuntimeMode {
    return app.isPackaged ? "production" : "non-production";
}

function resolveFeedTarget() {
    if (process.platform === "darwin") {
        return `darwin-${process.arch}`;
    }
    if (process.platform === "win32") {
        return `windows-${process.arch}`;
    }
    return null;
}

function resolveMetadataFileName() {
    if (process.platform === "darwin") {
        return "latest-mac.yml";
    }
    if (process.platform === "win32") {
        return "latest.yml";
    }
    return null;
}

function buildUpdaterEndpoint(baseUrl: string, channel: string, feedTarget: string) {
    const root = baseUrl.replace(/\/+$/, "");
    return `${root}/${channel}/${feedTarget}/`;
}

function resolveEndpointFromEnv(
    channel: string,
    feedTarget: string | null,
    metadataFileName: string | null,
) {
    const explicitEndpoint = readFirstNonEmptyEnv(UPDATER_ENDPOINT_ENV_VARS);
    if (explicitEndpoint) {
        return explicitEndpoint;
    }

    const baseUrl = readFirstNonEmptyEnv(UPDATER_BASE_URL_ENV_VARS);
    if (!baseUrl || !feedTarget || !metadataFileName) {
        return null;
    }

    return `${buildUpdaterEndpoint(baseUrl, channel, feedTarget)}${metadataFileName}`;
}

function loadUpdaterRuntimeConfig(): UpdaterRuntimeConfig {
    const channel = normalizeUpdaterChannel(
        readFirstNonEmptyEnv(UPDATER_CHANNEL_ENV_VARS),
    );
    const runtimeMode = currentUpdaterRuntimeMode();
    const allowedFeedHosts = readCsvEnv(UPDATER_ALLOWED_FEED_HOSTS_ENV_VARS);
    const allowedDownloadHosts = readCsvEnv(
        UPDATER_ALLOWED_DOWNLOAD_HOSTS_ENV_VARS,
    );
    const allowProdEndpointsInNonProd = readEnvFlag(
        UPDATER_ALLOW_PROD_ENDPOINTS_IN_NON_PROD_ENV_VARS,
    );
    const feedTarget = resolveFeedTarget();
    const metadataFileName = resolveMetadataFileName();
    const endpointDisplay = resolveEndpointFromEnv(
        channel,
        feedTarget,
        metadataFileName,
    );

    if (!feedTarget || !metadataFileName) {
        return {
            channel,
            runtimeMode,
            endpoint: null,
            endpointDisplay,
            endpointError: "Updater is only supported on macOS and Windows builds.",
            feedDirectoryUrl: null,
            feedTarget,
            metadataFileName,
            allowedFeedHosts,
            allowedDownloadHosts,
            allowProdEndpointsInNonProd,
        };
    }

    if (!endpointDisplay) {
        return {
            channel,
            runtimeMode,
            endpoint: null,
            endpointDisplay: null,
            endpointError: null,
            feedDirectoryUrl: null,
            feedTarget,
            metadataFileName,
            allowedFeedHosts,
            allowedDownloadHosts,
            allowProdEndpointsInNonProd,
        };
    }

    try {
        const parsed = new URL(endpointDisplay);
        validateUpdaterEndpointUrl(
            parsed,
            runtimeMode,
            allowProdEndpointsInNonProd,
            allowedFeedHosts,
        );
        if (
            parsed.pathname.endsWith(".yml") &&
            !parsed.pathname.endsWith(`/${metadataFileName}`)
        ) {
            throw new Error(
                `Updater endpoint must resolve to ${metadataFileName} for this platform: ${parsed}`,
            );
        }

        const endpoint = parsed.pathname.endsWith(`/${metadataFileName}`)
            ? parsed
            : new URL(metadataFileName, ensureTrailingSlashUrl(parsed));

        validateUpdaterEndpointUrl(
            endpoint,
            runtimeMode,
            allowProdEndpointsInNonProd,
            allowedFeedHosts,
        );

        return {
            channel,
            runtimeMode,
            endpoint,
            endpointDisplay: endpoint.toString(),
            endpointError: null,
            feedDirectoryUrl: new URL(".", endpoint).toString(),
            feedTarget,
            metadataFileName,
            allowedFeedHosts,
            allowedDownloadHosts,
            allowProdEndpointsInNonProd,
        };
    } catch (error) {
        return {
            channel,
            runtimeMode,
            endpoint: null,
            endpointDisplay,
            endpointError:
                error instanceof Error
                    ? error.message
                    : `Invalid updater endpoint '${endpointDisplay}'.`,
            feedDirectoryUrl: null,
            feedTarget,
            metadataFileName,
            allowedFeedHosts,
            allowedDownloadHosts,
            allowProdEndpointsInNonProd,
        };
    }
}

function ensureTrailingSlashUrl(url: URL) {
    const next = new URL(url.toString());
    if (!next.pathname.endsWith("/")) {
        next.pathname += "/";
    }
    return next;
}

function buildUpdateStatus(
    config: UpdaterRuntimeConfig,
    update: AvailableAppUpdateDto | null,
): AppUpdateStatusDto {
    return {
        enabled: config.endpoint !== null && config.endpointError === null,
        currentVersion: app.getVersion(),
        channel: config.channel,
        endpoint: config.endpointDisplay,
        message: config.endpointError,
        update,
    };
}

function createUpdaterLogger(): LoggerLike {
    return {
        info(message) {
            console.info("[electron-updater]", message);
        },
        warn(message) {
            console.warn("[electron-updater]", message);
        },
        error(message) {
            console.error("[electron-updater]", message);
        },
        debug(message) {
            console.debug("[electron-updater]", message);
        },
    };
}

function createPlatformUpdater(feedDirectoryUrl: string) {
    const options = {
        provider: "generic" as const,
        url: feedDirectoryUrl,
    };

    const updater: AppUpdater =
        process.platform === "darwin"
            ? new MacUpdater(options)
            : new NsisUpdater(options);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.forceDevUpdateConfig = !app.isPackaged;
    updater.logger = createUpdaterLogger();
    return updater;
}

function extractReleaseBody(updateInfo: UpdateInfo) {
    if (typeof updateInfo.releaseNotes === "string") {
        return updateInfo.releaseNotes;
    }

    if (Array.isArray(updateInfo.releaseNotes)) {
        return updateInfo.releaseNotes
            .map((entry) => {
                if (!entry.note?.trim()) {
                    return null;
                }
                return `## ${entry.version}\n\n${entry.note.trim()}`;
            })
            .filter((value): value is string => Boolean(value))
            .join("\n\n")
            .trim();
    }

    return null;
}

function cloneJsonValue<T>(value: T) {
    return JSON.parse(JSON.stringify(value)) as T;
}

function resolvePrimaryDownloadUrl(
    updateInfo: UpdateInfo,
    config: UpdaterRuntimeConfig,
) {
    const candidate =
        updateInfo.files.find((file) => !file.url.endsWith(".blockmap")) ??
        updateInfo.files[0];
    if (!candidate) {
        throw new Error("Updater did not provide downloadable files.");
    }

    if (!config.feedDirectoryUrl) {
        throw new Error("Updater feed directory is missing.");
    }

    return new URL(candidate.url, config.feedDirectoryUrl);
}

function validateAvailableUpdate(
    updateInfo: UpdateInfo,
    config: UpdaterRuntimeConfig,
) {
    if (!updateInfo.version.trim()) {
        throw new Error("Updater returned an empty version.");
    }
    if (updateInfo.files.length === 0) {
        throw new Error("Updater did not provide any downloadable files.");
    }

    if (!config.feedTarget) {
        throw new Error("Updater target could not be determined for this platform.");
    }
    if (!config.feedDirectoryUrl) {
        throw new Error("Updater feed directory is missing.");
    }

    for (const file of updateInfo.files) {
        validateUpdateDownloadUrl(
            new URL(file.url, config.feedDirectoryUrl),
            config.runtimeMode,
            config.allowProdEndpointsInNonProd,
            config.allowedDownloadHosts,
        );
    }
}

function serializeAvailableUpdate(
    updateInfo: UpdateInfo,
    config: UpdaterRuntimeConfig,
): AvailableAppUpdateDto {
    const downloadUrl = resolvePrimaryDownloadUrl(updateInfo, config);
    validateUpdateDownloadUrl(
        downloadUrl,
        config.runtimeMode,
        config.allowProdEndpointsInNonProd,
        config.allowedDownloadHosts,
    );

    return {
        body: extractReleaseBody(updateInfo),
        currentVersion: app.getVersion(),
        version: updateInfo.version,
        date: updateInfo.releaseDate ?? null,
        target: config.feedTarget ?? "unknown",
        downloadUrl: downloadUrl.toString(),
        rawJson: cloneJsonValue(updateInfo),
    };
}

export interface AppUpdaterBackend {
    getConfiguration(): AppUpdateStatusDto;
    checkForUpdates(): Promise<AppUpdateStatusDto>;
    downloadAndInstallUpdate(version: string, target: string): Promise<void>;
}

export class ElectronAppUpdater implements AppUpdaterBackend {
    private cachedUpdate: AvailableAppUpdateDto | null = null;
    private updater: AppUpdater | null = null;
    private feedDirectoryUrl: string | null = null;

    getConfiguration() {
        const config = this.loadConfig();
        return buildUpdateStatus(config, this.cachedUpdate);
    }

    async checkForUpdates() {
        const config = this.loadConfig();
        const baseline = buildUpdateStatus(config, null);
        if (!baseline.enabled) {
            this.cachedUpdate = null;
            return baseline;
        }

        const updater = this.getOrCreateUpdater(config);
        const result = await updater.checkForUpdates();
        if (!result?.isUpdateAvailable) {
            this.cachedUpdate = null;
            return buildUpdateStatus(config, null);
        }

        validateAvailableUpdate(result.updateInfo, config);
        const serialized = serializeAvailableUpdate(result.updateInfo, config);
        this.cachedUpdate = serialized;
        return buildUpdateStatus(config, serialized);
    }

    async downloadAndInstallUpdate(version: string, target: string) {
        const config = this.loadConfig();
        const baseline = buildUpdateStatus(config, null);
        if (!baseline.enabled) {
            throw new Error(
                baseline.message || "Updater is not enabled in this build.",
            );
        }

        const currentTarget = config.feedTarget;
        if (!currentTarget) {
            throw new Error("Updater target is missing for this platform.");
        }
        if (target !== currentTarget) {
            throw new Error(
                `Update target changed while preparing install. Expected target ${target}, got ${currentTarget}.`,
            );
        }

        let update = this.cachedUpdate;
        if (!update || update.version !== version || update.target !== target) {
            const refreshed = await this.checkForUpdates();
            update = refreshed.update;
        }

        if (!update) {
            throw new Error("No update is currently available.");
        }
        if (update.version !== version) {
            throw new Error(
                `Update changed while preparing install. Expected version ${version}, got ${update.version}.`,
            );
        }

        const updater = this.getOrCreateUpdater(config);
        await updater.downloadUpdate();
        setImmediate(() => {
            updater.quitAndInstall();
        });
    }

    private loadConfig() {
        return loadUpdaterRuntimeConfig();
    }

    private getOrCreateUpdater(config: UpdaterRuntimeConfig) {
        if (!config.feedDirectoryUrl) {
            throw new Error("Updater feed directory is missing at runtime.");
        }

        if (!this.updater || this.feedDirectoryUrl !== config.feedDirectoryUrl) {
            this.updater = createPlatformUpdater(config.feedDirectoryUrl);
            this.feedDirectoryUrl = config.feedDirectoryUrl;
            this.cachedUpdate = null;
        }

        return this.updater;
    }
}
