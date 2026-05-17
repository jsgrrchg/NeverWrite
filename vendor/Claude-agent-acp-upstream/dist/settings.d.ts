import { type Settings } from "@anthropic-ai/claude-agent-sdk";
export interface SettingsManagerOptions {
    onChange?: () => void;
    logger?: {
        log: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
}
/**
 * Manages Claude Code settings using the SDK's `resolveSettings` merge engine
 * so the values we see match what `query()` would observe.
 *
 * Watches the user/project/local/managed settings files for changes and
 * re-resolves through the SDK on update. Escalating `permissions.defaultMode`
 * values from repo-committed sources are filtered out via
 * `filterEscalatingDefaultMode`, matching the CLI's trust policy.
 */
export declare class SettingsManager {
    private cwd;
    private effective;
    private watchers;
    private onChange?;
    private logger;
    private initialized;
    private disposed;
    private debounceTimer;
    private initPromise;
    constructor(cwd: string, options?: SettingsManagerOptions);
    /**
     * Initialize the settings manager by loading all settings and setting up file watchers
     */
    initialize(): Promise<void>;
    /**
     * Paths the SDK reads when resolving settings for this cwd. Watching the
     * containing directories means we pick up file creation as well as edits.
     */
    private getWatchedPaths;
    /**
     * Resolves the effective settings via the SDK and applies the CLI's trust
     * filter for escalating `permissions.defaultMode` values.
     */
    private loadAllSettings;
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
    getSettings(): Settings;
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