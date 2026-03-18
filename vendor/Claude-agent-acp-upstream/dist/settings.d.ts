/**
 * Permission rule format examples:
 * - "Read" - matches all Read tool calls
 * - "Read(./.env)" - matches specific path
 * - "Read(./.env.*)" - glob pattern
 * - "Read(./secrets/**)" - recursive glob
 * - "Bash(npm run lint)" - exact command prefix
 * - "Bash(npm run:*)" - command prefix with wildcard
 *
 * Docs: https://code.claude.com/docs/en/iam#tool-specific-permission-rules
 */
export interface PermissionSettings {
    defaultMode?: string;
}
export interface ClaudeCodeSettings {
    permissions?: PermissionSettings;
    env?: Record<string, string>;
    model?: string;
}
/**
 * Gets the enterprise settings path based on the current platform
 */
export declare function getManagedSettingsPath(): string;
export interface SettingsManagerOptions {
    onChange?: () => void;
    logger?: {
        log: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
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
export declare class SettingsManager {
    private cwd;
    private userSettings;
    private projectSettings;
    private localSettings;
    private enterpriseSettings;
    private mergedSettings;
    private watchers;
    private onChange?;
    private logger;
    private initialized;
    private debounceTimer;
    constructor(cwd: string, options?: SettingsManagerOptions);
    /**
     * Initialize the settings manager by loading all settings and setting up file watchers
     */
    initialize(): Promise<void>;
    /**
     * Returns the path to the user settings file
     */
    private getUserSettingsPath;
    /**
     * Returns the path to the project settings file
     */
    private getProjectSettingsPath;
    /**
     * Returns the path to the local project settings file
     */
    private getLocalSettingsPath;
    /**
     * Loads settings from all sources
     */
    private loadAllSettings;
    /**
     * Merges all settings sources with proper precedence.
     * For permissions, rules from all sources are combined.
     * Deny rules always take precedence during permission checks.
     */
    private mergeSettings;
    /**
     * Sets up file watchers for all settings files
     */
    private setupWatchers;
    /**
     * Handles settings file changes with debouncing to avoid rapid reloads
     */
    private handleSettingsChange;
    /**
     * Returns the current merged settings
     */
    getSettings(): ClaudeCodeSettings;
    /**
     * Returns the current working directory
     */
    getCwd(): string;
    /**
     * Updates the working directory and reloads project-specific settings
     */
    setCwd(cwd: string): Promise<void>;
    /**
     * Disposes of file watchers and cleans up resources
     */
    dispose(): void;
}
//# sourceMappingURL=settings.d.ts.map