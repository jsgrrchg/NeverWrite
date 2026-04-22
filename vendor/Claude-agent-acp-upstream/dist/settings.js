import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_CONFIG_DIR } from "./acp-agent.js";
/**
 * Reads and parses a JSON settings file, returning an empty object if not found or invalid.
 * Silently ignores missing files (ENOENT) but logs warnings for other errors
 * (malformed JSON, permission errors, etc.) to aid debugging.
 */
async function loadSettingsFile(filePath, logger) {
    if (!filePath) {
        return {};
    }
    try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {};
        }
        logger?.error(`Failed to load settings from ${filePath}:`, error);
        return {};
    }
}
/**
 * Gets the enterprise settings path based on the current platform
 */
export function getManagedSettingsPath() {
    switch (process.platform) {
        case "darwin":
            return "/Library/Application Support/ClaudeCode/managed-settings.json";
        case "linux":
            return "/etc/claude-code/managed-settings.json";
        case "win32":
            return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
        default:
            return "/etc/claude-code/managed-settings.json";
    }
}
/**
 * Manages Claude Code settings from multiple sources with proper precedence.
 *
 * Settings are loaded from (in order of increasing precedence):
 * 1. User settings (~/.claude/settings.json)
 * 2. Project settings (<cwd>/.claude/settings.json)
 * 3. Local project settings (<cwd>/.claude/settings.local.json)
 * 4. Enterprise managed settings (platform-specific path)
 *
 * The manager watches all settings files for changes and automatically reloads.
 */
export class SettingsManager {
    constructor(cwd, options) {
        this.userSettings = {};
        this.projectSettings = {};
        this.localSettings = {};
        this.enterpriseSettings = {};
        this.mergedSettings = {};
        this.watchers = [];
        this.initialized = false;
        this.disposed = false;
        this.debounceTimer = null;
        this.initPromise = null;
        this.cwd = cwd;
        this.onChange = options?.onChange;
        this.logger = options?.logger ?? console;
    }
    /**
     * Initialize the settings manager by loading all settings and setting up file watchers
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        if (this.initPromise) {
            return this.initPromise;
        }
        this.disposed = false;
        this.initPromise = this.loadAllSettings().then(() => {
            if (!this.disposed) {
                this.setupWatchers();
                this.initialized = true;
            }
            this.initPromise = null;
        });
        return this.initPromise;
    }
    /**
     * Returns the path to the user settings file
     */
    getUserSettingsPath() {
        return path.join(CLAUDE_CONFIG_DIR, "settings.json");
    }
    /**
     * Returns the path to the project settings file
     */
    getProjectSettingsPath() {
        return path.join(this.cwd, ".claude", "settings.json");
    }
    /**
     * Returns the path to the local project settings file
     */
    getLocalSettingsPath() {
        return path.join(this.cwd, ".claude", "settings.local.json");
    }
    /**
     * Loads settings from all sources
     */
    async loadAllSettings() {
        const [userSettings, projectSettings, localSettings, enterpriseSettings] = await Promise.all([
            loadSettingsFile(this.getUserSettingsPath(), this.logger),
            loadSettingsFile(this.getProjectSettingsPath(), this.logger),
            loadSettingsFile(this.getLocalSettingsPath(), this.logger),
            loadSettingsFile(getManagedSettingsPath(), this.logger),
        ]);
        this.userSettings = userSettings;
        this.projectSettings = projectSettings;
        this.localSettings = localSettings;
        this.enterpriseSettings = enterpriseSettings;
        this.mergeSettings();
    }
    /**
     * Merges all settings sources with proper precedence.
     * For permissions, rules from all sources are combined.
     * Deny rules always take precedence during permission checks.
     */
    mergeSettings() {
        const allSettings = [
            this.userSettings,
            this.projectSettings,
            this.localSettings,
            this.enterpriseSettings,
        ];
        const merged = {};
        for (const settings of allSettings) {
            if (settings.env) {
                merged.env = { ...merged.env, ...settings.env };
            }
            if (settings.model) {
                merged.model = settings.model;
            }
            if (settings.effortLevel !== undefined) {
                merged.effortLevel = settings.effortLevel;
            }
            if (settings.permissions?.defaultMode !== undefined) {
                merged.permissions = {
                    ...merged.permissions,
                    defaultMode: settings.permissions.defaultMode,
                };
            }
        }
        this.mergedSettings = merged;
    }
    /**
     * Sets up file watchers for all settings files
     */
    setupWatchers() {
        const paths = [
            this.getUserSettingsPath(),
            this.getProjectSettingsPath(),
            this.getLocalSettingsPath(),
            getManagedSettingsPath(),
        ];
        for (const filePath of paths) {
            if (!filePath)
                continue;
            try {
                const dir = path.dirname(filePath);
                const filename = path.basename(filePath);
                if (fs.existsSync(dir)) {
                    const watcher = fs.watch(dir, (eventType, changedFilename) => {
                        if (changedFilename === filename) {
                            this.handleSettingsChange();
                        }
                    });
                    watcher.on("error", (error) => {
                        this.logger.error(`Settings watcher error for ${filePath}:`, error);
                    });
                    this.watchers.push(watcher);
                }
            }
            catch (error) {
                this.logger.error(`Failed to set up watcher for ${filePath}:`, error);
            }
        }
    }
    /**
     * Handles settings file changes with debouncing to avoid rapid reloads
     */
    handleSettingsChange() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(async () => {
            this.debounceTimer = null;
            if (this.disposed) {
                return;
            }
            try {
                await this.loadAllSettings();
                if (!this.disposed) {
                    this.onChange?.();
                }
            }
            catch (error) {
                this.logger.error("Failed to reload settings:", error);
            }
        }, 100);
    }
    /**
     * Returns the current merged settings
     */
    getSettings() {
        return this.mergedSettings;
    }
    /**
     * Returns the current working directory
     */
    getCwd() {
        return this.cwd;
    }
    /**
     * Updates the working directory and reloads project-specific settings
     */
    async setCwd(cwd) {
        if (this.cwd === cwd) {
            return;
        }
        this.dispose();
        this.cwd = cwd;
        await this.initialize();
    }
    /**
     * Disposes of file watchers and cleans up resources
     */
    dispose() {
        this.disposed = true;
        this.initialized = false;
        this.initPromise = null;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        for (const watcher of this.watchers) {
            watcher.close();
        }
        this.watchers = [];
    }
}
