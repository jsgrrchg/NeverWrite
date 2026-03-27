import { useEffect, useMemo, useState } from "react";
import {
    DesktopApiError,
    fetchDesktopContext,
    saveClipToDesktop,
} from "../../lib/desktop-api";
import { recordClipHistory } from "../../lib/history";
import {
    mergeRecentValues,
    normalizeFolderHint,
    parseTagInput,
    recordClipperUsage,
} from "../../lib/clipper-preferences";
import {
    CLIPPER_SOURCE_TAB_QUERY_PARAM,
    createClipperExtractMessage,
    type ClipData,
    type ClipperExtractResponse,
} from "../../lib/clipper-contract";
import { writeClipboardText } from "../../lib/clipboard";
import { createClipRequestDraft } from "../../lib/clip-request";
import { createClipDeepLink, openDeepLink } from "../../lib/deep-link";
import {
    createDefaultClipperSettings,
    loadClipperSettings,
    saveClipperSettings,
} from "../../lib/storage";
import {
    renderClipTemplate,
    resolveClipTemplate,
} from "../../lib/template-engine";
import { buildClipMarkdown } from "../../lib/clip-markdown";
import type { ClipperSettings, ClipContentMode } from "../../lib/types";
import FolderSelector from "./components/FolderSelector";
import SaveButton, { type SaveButtonStatus } from "./components/SaveButton";
import SettingsPage from "./components/SettingsPage";
import TagEditor from "./components/TagEditor";
import UrlField from "./components/UrlField";
import VaultSelector from "./components/VaultSelector";

type ExtractionStatus = "loading" | "ready" | "error";
type SendStatus = SaveButtonStatus;
type ClipperView = "clip" | "settings";

interface AppProps {
    surface?: "window" | "sidepanel" | "popup";
}

function readSourceTabIdFromLocation(): number | null {
    const rawValue = new URLSearchParams(window.location.search).get(
        CLIPPER_SOURCE_TAB_QUERY_PARAM,
    );
    if (!rawValue) return null;
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return "The clipper could not complete the requested action.";
}

function buildMarkdownPreview(
    clipData: ClipData,
    title: string,
    tags: string[],
    folder: string,
    contentMode: ClipContentMode,
    templateBody: string,
    notes?: string,
): string {
    return renderClipTemplate(templateBody, {
        clipData,
        title,
        tags,
        folder,
        content: buildClipMarkdown({
            clipData,
            title,
            tags,
            notes,
            contentMode,
        }),
    }).trim();
}

export function App(_props: AppProps) {
    const [locationSourceTabId] = useState<number | null>(() =>
        readSourceTabIdFromLocation(),
    );
    const [sourceTabId, setSourceTabId] = useState<number | null>(null);
    const [sourceTabResolved, setSourceTabResolved] = useState(false);
    const [settings, setSettings] = useState<ClipperSettings | null>(null);
    const [view, setView] = useState<ClipperView>("clip");
    const [status, setStatus] = useState<ExtractionStatus>("loading");
    const [errorMessage, setErrorMessage] = useState("");
    const [clipData, setClipData] = useState<ClipData | null>(null);
    const [title, setTitle] = useState("");
    const [tags, setTags] = useState<string[]>([]);
    const [notes, setNotes] = useState("");
    const [folder, setFolder] = useState("");
    const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
    const [sendMessage, setSendMessage] = useState("");
    const [lastDeepLink, setLastDeepLink] = useState("");
    const [desktopApiAvailable, setDesktopApiAvailable] = useState(false);
    const [desktopFolders, setDesktopFolders] = useState<string[]>([]);
    const [desktopTags, setDesktopTags] = useState<string[]>([]);

    const activeVault = settings?.vaults[settings.activeVaultIndex] ?? null;

    const contentMode: ClipContentMode = useMemo(() => {
        if (clipData?.selection && settings?.clipSelectedOnly)
            return "selection";
        return "full-page";
    }, [clipData?.selection, settings?.clipSelectedOnly]);

    // --- Source tab resolution ---
    useEffect(() => {
        let cancelled = false;
        async function resolve() {
            if (typeof locationSourceTabId === "number") {
                if (!cancelled) {
                    setSourceTabId(locationSourceTabId);
                    setSourceTabResolved(true);
                }
                return;
            }
            try {
                const [activeTab] = await browser.tabs.query({
                    active: true,
                    lastFocusedWindow: true,
                });
                if (!cancelled) setSourceTabId(activeTab?.id ?? null);
            } catch {
                if (!cancelled) setSourceTabId(null);
            } finally {
                if (!cancelled) setSourceTabResolved(true);
            }
        }
        void resolve();
        return () => {
            cancelled = true;
        };
    }, [locationSourceTabId]);

    // --- Settings load ---
    useEffect(() => {
        let cancelled = false;
        async function init() {
            try {
                const loaded = await loadClipperSettings();
                if (!cancelled) setSettings(loaded);
            } catch {
                if (!cancelled) setSettings(createDefaultClipperSettings());
            }
        }
        void init();
        return () => {
            cancelled = true;
        };
    }, []);

    // --- Clip extraction ---
    async function loadClipData() {
        if (!sourceTabResolved) return;

        let targetTabId = sourceTabId;
        if (locationSourceTabId == null) {
            try {
                const [activeTab] = await browser.tabs.query({
                    active: true,
                    lastFocusedWindow: true,
                });
                targetTabId = activeTab?.id ?? null;
                setSourceTabId(targetTabId);
            } catch {
                targetTabId = null;
                setSourceTabId(null);
            }
        }

        if (targetTabId == null) {
            setStatus("error");
            setErrorMessage(
                "No source tab attached. Re-open the clipper from the page you want to capture.",
            );
            return;
        }

        try {
            setStatus("loading");
            setErrorMessage("");
            const response = (await browser.tabs.sendMessage(
                targetTabId,
                createClipperExtractMessage(),
            )) as ClipperExtractResponse | undefined;

            if (!response)
                throw new Error("The source tab did not return any clip data.");
            if (!response.ok) throw new Error(response.error);

            setClipData(response.data);
            setTitle(response.data.metadata.title);
            setTags(parseTagInput(response.data.metadata.domain));
            setSendStatus("idle");
            setSendMessage("");
            setLastDeepLink("");
            setStatus("ready");
        } catch (error) {
            setStatus("error");
            setErrorMessage(extractErrorMessage(error));
        }
    }

    useEffect(() => {
        void loadClipData();
    }, [sourceTabId, sourceTabResolved]);

    // --- Folder default ---
    useEffect(() => {
        setFolder(activeVault?.defaultFolder ?? "");
    }, [activeVault?.defaultFolder, activeVault?.id]);

    // --- Desktop autocomplete ---
    useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!activeVault) return;
            try {
                const ctx = await fetchDesktopContext({
                    vaultPathHint: activeVault.path,
                    vaultNameHint: activeVault.name,
                });
                if (cancelled) return;
                setDesktopApiAvailable(ctx.available);
                setDesktopFolders(ctx.folders);
                setDesktopTags(ctx.tags);
            } catch (error) {
                if (cancelled) return;
                setDesktopApiAvailable(false);
                setDesktopFolders([]);
                setDesktopTags([]);
            }
        }
        void load();
        return () => {
            cancelled = true;
        };
    }, [activeVault?.id, activeVault?.name, activeVault?.path]);

    // --- Suggestions ---
    const tagSuggestions = useMemo(() => {
        if (!settings) return [];
        return mergeRecentValues(
            [...settings.recentTags, ...desktopTags],
            [
                clipData?.metadata.domain ?? "",
                clipData?.metadata.author ?? "",
                clipData?.metadata.language ?? "",
            ],
            20,
        );
    }, [clipData, desktopTags, settings]);

    const folderSuggestions = useMemo(() => {
        if (!settings || !activeVault) return [];
        return mergeRecentValues(
            [
                activeVault.defaultFolder,
                ...activeVault.folderHints,
                ...(settings.recentFoldersByVault[activeVault.id] ?? []),
                ...desktopFolders,
            ],
            [],
            16,
        );
    }, [activeVault, desktopFolders, settings]);

    // --- Template & preview ---
    const resolvedTemplate =
        clipData === null || settings === null || activeVault === null
            ? null
            : resolveClipTemplate({
                  templates: settings.templates,
                  defaultTemplate: settings.defaultTemplate,
                  vaultId: activeVault.id,
                  domain: clipData.metadata.domain,
              });

    const previewMarkdown =
        clipData === null || resolvedTemplate === null
            ? ""
            : buildMarkdownPreview(
                  clipData,
                  title,
                  tags,
                  folder,
                  contentMode,
                  resolvedTemplate.body,
                  notes,
              );
    const vaultOptions =
        settings?.vaults.map((v) => ({ value: v.id, label: v.name })) ?? [];

    // --- Enter to save ---
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (
                e.key === "Enter" &&
                !e.metaKey &&
                !e.ctrlKey &&
                view === "clip" &&
                status === "ready" &&
                sendStatus !== "sending"
            ) {
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === "TEXTAREA") return;
                e.preventDefault();
                void handleSave();
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    });

    // --- Handlers ---
    async function persistSettings(next: ClipperSettings) {
        const saved = await saveClipperSettings(next);
        setSettings(saved);
    }

    async function handleVaultChange(vaultId: string) {
        if (!settings) return;
        const idx = settings.vaults.findIndex((v) => v.id === vaultId);
        if (idx < 0) return;
        await persistSettings({ ...settings, activeVaultIndex: idx });
    }

    function handleOpenSettings() {
        setView("settings");
    }

    async function handleCloseSettings() {
        try {
            if (settings) await persistSettings(settings);
        } finally {
            setView("clip");
        }
    }

    async function handleSave() {
        if (!clipData || !settings || !activeVault || !resolvedTemplate) return;

        if (sendStatus === "sent" && lastDeepLink && !desktopApiAvailable) {
            openDeepLink(lastDeepLink);
            return;
        }

        try {
            setSendStatus("sending");
            setSendMessage("");
            const normalizedFolder = normalizeFolderHint(folder);
            const normalizedTitle = title.trim() || clipData.metadata.title;
            const requestId = crypto.randomUUID();
            const nextSettings = recordClipperUsage(settings, {
                vaultId: activeVault.id,
                folder,
                tags,
            });

            try {
                const response = await saveClipToDesktop({
                    requestId,
                    title: normalizedTitle,
                    content: previewMarkdown,
                    folder: normalizedFolder,
                    tags,
                    sourceUrl: clipData.metadata.url,
                    vaultPathHint: activeVault.path,
                    vaultNameHint: activeVault.name,
                });

                const persisted = recordClipHistory(nextSettings, {
                    requestId,
                    clipData,
                    markdown: previewMarkdown,
                    title: normalizedTitle,
                    tags,
                    folder: normalizedFolder,
                    method: "desktop-api",
                    status: "saved",
                    contentMode,
                    vaultId: activeVault.id,
                    vaultName: activeVault.name,
                    templateId: resolvedTemplate.id,
                });
                setSettings(persisted);
                void saveClipperSettings(persisted);
                setLastDeepLink("");
                setSendStatus("sent");
                setSendMessage(response.message);
                setTimeout(() => window.close(), 600);
                return;
            } catch (error) {
                if (error instanceof DesktopApiError && !error.isUnavailable) {
                    setSendStatus("error");
                    setSendMessage(error.message);
                    return;
                }

                const draft = createClipRequestDraft({
                    clipData,
                    contentMarkdown: previewMarkdown,
                    title: normalizedTitle,
                    vault:
                        activeVault.path || activeVault.name || activeVault.id,
                    vaultPathHint: activeVault.path || undefined,
                    vaultNameHint: activeVault.name || undefined,
                    folder: normalizedFolder,
                    preferClipboard: settings.useClipboard,
                });

                if (draft.clipboardMarkdown !== null) {
                    await writeClipboardText(draft.clipboardMarkdown);
                }

                const persisted = recordClipHistory(nextSettings, {
                    requestId: draft.payload.requestId,
                    clipData,
                    markdown: previewMarkdown,
                    title: normalizedTitle,
                    tags,
                    folder: normalizedFolder,
                    method:
                        draft.payload.mode === "clipboard"
                            ? "deep-link-clipboard"
                            : "deep-link-inline",
                    status: "handoff",
                    contentMode,
                    vaultId: activeVault.id,
                    vaultName: activeVault.name,
                    templateId: resolvedTemplate.id,
                });
                setSettings(persisted);
                void saveClipperSettings(persisted);

                const deepLink = createClipDeepLink(draft.payload);
                setLastDeepLink(deepLink);
                setDesktopApiAvailable(false);
                openDeepLink(deepLink);
                setSendStatus("sent");
                setSendMessage(
                    draft.payload.mode === "clipboard"
                        ? "Prepared clipboard bridge handoff."
                        : "Prepared deep link handoff.",
                );
                setTimeout(() => window.close(), 600);
            }
        } catch (error) {
            setSendStatus("error");
            setSendMessage(extractErrorMessage(error));
        }
    }

    // --- Render ---
    const isLoading =
        settings === null || !sourceTabResolved || status === "loading";

    return (
        <main className="flex h-screen flex-col bg-surface text-fg">
            <div className="h-px bg-edge" />

            {view === "settings" && settings !== null && (
                <>
                    <SettingsPage settings={settings} onChange={setSettings} />
                    <div className="h-px bg-edge" />
                    <footer className="flex h-10 shrink-0 items-center bg-surface-alt px-2.5">
                        <button
                            type="button"
                            onClick={() => {
                                void handleCloseSettings();
                            }}
                            className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium text-fg-muted transition hover:text-fg"
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="m15 18-6-6 6-6" />
                            </svg>
                            Back
                        </button>
                    </footer>
                </>
            )}

            {view === "clip" && (
                <>
                    <div className="flex-1 overflow-y-auto">
                        {isLoading && (
                            <div className="flex flex-col gap-2.5 px-3 pt-3">
                                <div className="h-2.5 w-14 animate-pulse rounded bg-surface-hover" />
                                <div className="h-7 animate-pulse rounded-md bg-surface-raised" />
                                <div className="h-2.5 w-14 animate-pulse rounded bg-surface-hover" />
                                <div className="h-24 animate-pulse rounded-md bg-surface-raised" />
                                <div className="h-2.5 w-14 animate-pulse rounded bg-surface-hover" />
                                <div className="h-7 animate-pulse rounded-md bg-surface-raised" />
                            </div>
                        )}

                        {!isLoading && status === "error" && (
                            <div className="flex flex-col gap-2.5 px-3 pt-3">
                                <div className="rounded-md border border-danger/30 bg-danger/10 p-2.5">
                                    <p className="text-[11px] font-semibold text-danger">
                                        Extraction failed
                                    </p>
                                    <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
                                        {errorMessage}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void loadClipData();
                                        }}
                                        className="mt-1.5 inline-flex h-6 items-center rounded-md border border-danger/30 px-2.5 text-[10px] font-medium text-danger transition hover:bg-danger/10"
                                    >
                                        Retry
                                    </button>
                                </div>
                            </div>
                        )}

                        {!isLoading &&
                            status === "ready" &&
                            clipData !== null && (
                                <div className="flex flex-col gap-2.5 px-3 pb-3 pt-3">
                                    <div>
                                        <label className="clip-label">
                                            Title
                                        </label>
                                        <input
                                            value={title}
                                            onChange={(e) =>
                                                setTitle(e.target.value)
                                            }
                                            className="mt-1 h-7 w-full rounded-md border border-edge bg-surface-raised px-2.5 text-[11px] font-medium text-fg outline-none placeholder:text-fg-dim focus:border-accent/50"
                                            placeholder="Note title"
                                        />
                                    </div>

                                    <div>
                                        <label className="clip-label">
                                            Notes
                                        </label>
                                        <textarea
                                            value={notes}
                                            onChange={(e) =>
                                                setNotes(e.target.value)
                                            }
                                            className="mt-1 h-24 w-full resize-none rounded-md border border-edge bg-surface-raised px-2.5 py-2 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-accent/50"
                                            placeholder="Add personal notes to this clip..."
                                        />
                                    </div>

                                    <div>
                                        <label className="clip-label">
                                            URL
                                        </label>
                                        <div className="mt-1">
                                            <UrlField
                                                url={clipData.metadata.url}
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className="clip-label">
                                            Tags
                                        </label>
                                        <div className="mt-1">
                                            <TagEditor
                                                tags={tags}
                                                suggestions={tagSuggestions}
                                                onChange={setTags}
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className="clip-label">
                                            Vault
                                        </label>
                                        <div className="mt-1 flex gap-1.5">
                                            <VaultSelector
                                                value={activeVault?.id ?? ""}
                                                options={vaultOptions}
                                                onChange={(v) => {
                                                    void handleVaultChange(v);
                                                }}
                                            />
                                            <FolderSelector
                                                value={folder}
                                                suggestions={folderSuggestions}
                                                onChange={setFolder}
                                            />
                                        </div>
                                    </div>

                                    {sendMessage && (
                                        <p
                                            className={`text-[10px] leading-relaxed ${sendStatus === "error" ? "text-danger" : "text-accent"}`}
                                        >
                                            {sendMessage}
                                        </p>
                                    )}
                                </div>
                            )}
                    </div>

                    <div className="h-px bg-edge" />

                    <footer className="flex h-10 shrink-0 items-center gap-1.5 bg-surface-alt px-2.5">
                        <button
                            type="button"
                            aria-label="Open settings"
                            onClick={handleOpenSettings}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition hover:text-fg"
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        </button>

                        {desktopApiAvailable ? (
                            <div className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2 py-1">
                                <div className="h-1.5 w-1.5 rounded-full bg-success" />
                                <span className="text-[10px] font-medium text-success">
                                    Connected
                                </span>
                            </div>
                        ) : (
                            <div className="inline-flex items-center gap-1 rounded-md bg-fg-dim/10 px-2 py-1">
                                <div className="h-1.5 w-1.5 rounded-full bg-fg-dim" />
                                <span className="text-[10px] font-medium text-fg-dim">
                                    Offline
                                </span>
                            </div>
                        )}

                        <div className="flex-1" />

                        <SaveButton
                            disabled={
                                sendStatus === "sending" ||
                                status !== "ready" ||
                                clipData === null
                            }
                            status={sendStatus}
                            onClick={() => {
                                void handleSave();
                            }}
                        />
                    </footer>
                </>
            )}
        </main>
    );
}

export default App;
