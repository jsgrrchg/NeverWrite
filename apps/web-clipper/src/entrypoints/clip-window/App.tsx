import { useDeferredValue, useEffect, useMemo, useState } from "react";
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
import type { ClipperSettings } from "../../lib/types";
import ClipForm, { type ClipContentMode } from "./components/ClipForm";
import HistoryPage from "./components/HistoryPage";
import MarkdownPreview from "./components/MarkdownPreview";
import SaveButton, { type SaveButtonStatus } from "./components/SaveButton";
import SettingsPage from "./components/SettingsPage";
import VaultSelector from "./components/VaultSelector";

type ExtractionStatus = "loading" | "ready" | "error";
type SendStatus = SaveButtonStatus;
type ClipperView = "clip" | "settings" | "history";
type ClipperSurface = "window" | "sidepanel";

function readSourceTabIdFromLocation(): number | null {
    const rawValue = new URLSearchParams(window.location.search).get(
        CLIPPER_SOURCE_TAB_QUERY_PARAM,
    );

    if (!rawValue) {
        return null;
    }

    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    return "The clipper could not complete the requested action.";
}

function buildMetadataLines(clipData: ClipData, tags: string): string[] {
    const lines = [
        `Source: ${clipData.metadata.url}`,
        `Domain: ${clipData.metadata.domain}`,
    ];

    if (clipData.metadata.author) {
        lines.push(`Author: ${clipData.metadata.author}`);
    }

    if (clipData.metadata.published) {
        lines.push(`Published: ${clipData.metadata.published}`);
    }

    if (clipData.metadata.description) {
        lines.push(`Description: ${clipData.metadata.description}`);
    }

    if (tags.trim()) {
        lines.push(`Tags: ${tags.trim()}`);
    }

    return lines;
}

function buildClipBody(
    clipData: ClipData,
    contentMode: ClipContentMode,
): string {
    switch (contentMode) {
        case "selection":
            return clipData.selection?.markdown || clipData.content.markdown;
        case "url-only":
            return [
                `[Open source](${clipData.metadata.url})`,
                "",
                clipData.metadata.description ||
                    "Bookmark-only clip. Full content disabled for this capture.",
            ].join("\n");
        default:
            return clipData.content.markdown;
    }
}

function buildMarkdownPreview(
    clipData: ClipData,
    title: string,
    tags: string[],
    folder: string,
    contentMode: ClipContentMode,
    templateBody: string,
): string {
    const header = [`# ${title || clipData.metadata.title}`, ""];
    const metadataLines = buildMetadataLines(clipData, tags.join(", "));

    if (metadataLines.length > 0) {
        header.push(...metadataLines, "");
    }

    const body = buildClipBody(clipData, contentMode);
    const composed = [...header, body].join("\n").trim();

    return renderClipTemplate(templateBody, {
        clipData,
        title,
        tags,
        folder,
        content: composed,
    }).trim();
}

interface SettingsButtonProps {
    onClick: () => void;
}

function SettingsButton({ onClick }: SettingsButtonProps) {
    return (
        <button
            type="button"
            aria-label="Open clipper settings"
            onClick={onClick}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[10px] border border-edge bg-surface-alt text-fg-muted transition hover:border-accent/35 hover:text-fg"
        >
            <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M12 3.75a2.25 2.25 0 0 1 2.19 1.73l.15.65a1.8 1.8 0 0 0 1.36 1.33l.68.17a2.25 2.25 0 0 1 1.45 3.22l-.34.59a1.8 1.8 0 0 0 0 1.79l.34.59a2.25 2.25 0 0 1-1.45 3.22l-.68.17a1.8 1.8 0 0 0-1.36 1.33l-.15.65a2.25 2.25 0 0 1-4.38 0l-.15-.65a1.8 1.8 0 0 0-1.36-1.33l-.68-.17a2.25 2.25 0 0 1-1.45-3.22l.34-.59a1.8 1.8 0 0 0 0-1.79l-.34-.59a2.25 2.25 0 0 1 1.45-3.22l.68-.17a1.8 1.8 0 0 0 1.36-1.33l.15-.65A2.25 2.25 0 0 1 12 3.75Z" />
                <circle cx="12" cy="12" r="3.25" />
            </svg>
        </button>
    );
}

function LoadingState() {
    return (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-xl border border-edge bg-surface-alt p-6">
                <div className="h-5 w-32 animate-pulse rounded-full bg-surface-hover" />
                <div className="mt-4 h-12 animate-pulse rounded-[10px] bg-surface-raised" />
                <div className="mt-4 h-12 animate-pulse rounded-[10px] bg-surface-raised" />
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="h-28 animate-pulse rounded-[10px] bg-surface-raised" />
                    <div className="h-28 animate-pulse rounded-[10px] bg-surface-raised" />
                    <div className="h-28 animate-pulse rounded-[10px] bg-surface-raised" />
                </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface-alt p-6">
                <div className="h-5 w-40 animate-pulse rounded-full bg-surface-hover" />
                <div className="mt-4 h-[360px] animate-pulse rounded-[10px] bg-surface-raised" />
            </div>
        </div>
    );
}

interface ErrorStateProps {
    errorMessage: string;
    onRetry: () => void;
}

function ErrorState({ errorMessage, onRetry }: ErrorStateProps) {
    return (
        <div className="rounded-xl border border-rose-400/25 bg-rose-400/10 p-6 shadow-soft">
            <p className="text-xs font-semibold uppercase tracking-wider text-rose-100/80">
                Extraction failed
            </p>
            <h2 className="mt-3 text-2xl font-semibold text-fg">
                The clipper could not read the source tab.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-rose-50/90">
                {errorMessage}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
                <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex h-11 items-center justify-center rounded-[10px] border border-rose-400/30 bg-rose-400/12 px-4 text-sm font-semibold text-fg transition hover:bg-rose-400/18"
                >
                    Retry extraction
                </button>
                <p className="self-center text-xs leading-6 text-rose-50/80">
                    Restricted pages like browser settings or internal tabs
                    cannot be clipped with a normal content script.
                </p>
            </div>
        </div>
    );
}

interface AppProps {
    surface?: ClipperSurface;
}

export function App({ surface = "window" }: AppProps) {
    const [locationSourceTabId] = useState<number | null>(() =>
        readSourceTabIdFromLocation(),
    );
    const [sourceTabId, setSourceTabId] = useState<number | null>(null);
    const [sourceTabResolved, setSourceTabResolved] = useState(false);
    const [settings, setSettings] = useState<ClipperSettings | null>(null);
    const [settingsDraft, setSettingsDraft] = useState<ClipperSettings | null>(
        null,
    );
    const [settingsSaveLabel, setSettingsSaveLabel] = useState("Save settings");
    const [view, setView] = useState<ClipperView>("clip");
    const [status, setStatus] = useState<ExtractionStatus>("loading");
    const [errorMessage, setErrorMessage] = useState("");
    const [clipData, setClipData] = useState<ClipData | null>(null);
    const [contentMode, setContentMode] =
        useState<ClipContentMode>("full-page");
    const [title, setTitle] = useState("");
    const [tags, setTags] = useState<string[]>([]);
    const [folder, setFolder] = useState("");
    const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
    const [sendMessage, setSendMessage] = useState("");
    const [lastDeepLink, setLastDeepLink] = useState("");
    const [desktopApiAvailable, setDesktopApiAvailable] = useState(false);
    const [desktopStatus, setDesktopStatus] = useState(
        "Desktop API unavailable",
    );
    const [desktopFolders, setDesktopFolders] = useState<string[]>([]);
    const [desktopTags, setDesktopTags] = useState<string[]>([]);
    const [desktopThemes, setDesktopThemes] = useState<
        Array<{ id: string; label: string }>
    >([]);

    useEffect(() => {
        let cancelled = false;

        async function resolveSourceTabId() {
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

                if (!cancelled) {
                    setSourceTabId(activeTab?.id ?? null);
                }
            } catch {
                if (!cancelled) {
                    setSourceTabId(null);
                }
            } finally {
                if (!cancelled) {
                    setSourceTabResolved(true);
                }
            }
        }

        void resolveSourceTabId();

        return () => {
            cancelled = true;
        };
    }, [locationSourceTabId]);

    useEffect(() => {
        let cancelled = false;

        async function initSettings() {
            try {
                const loaded = await loadClipperSettings();
                if (cancelled) {
                    return;
                }

                setSettings(loaded);
                setSettingsDraft(loaded);
            } catch {
                if (cancelled) {
                    return;
                }

                const fallback = createDefaultClipperSettings();
                setSettings(fallback);
                setSettingsDraft(fallback);
            }
        }

        void initSettings();

        return () => {
            cancelled = true;
        };
    }, []);

    const activeVault = settings?.vaults[settings.activeVaultIndex] ?? null;
    const selectionOnly =
        Boolean(settings?.clipSelectedOnly) && Boolean(clipData?.selection);

    async function persistSettings(nextSettings: ClipperSettings) {
        const saved = await saveClipperSettings(nextSettings);
        setSettings(saved);
        setSettingsDraft(saved);
    }

    async function loadClipData() {
        if (!sourceTabResolved) {
            return;
        }

        let targetSourceTabId = sourceTabId;

        if (locationSourceTabId == null) {
            try {
                const [activeTab] = await browser.tabs.query({
                    active: true,
                    lastFocusedWindow: true,
                });
                targetSourceTabId = activeTab?.id ?? null;
                setSourceTabId(targetSourceTabId);
            } catch {
                targetSourceTabId = null;
                setSourceTabId(null);
            }
        }

        if (targetSourceTabId == null) {
            setStatus("error");
            setErrorMessage(
                "No source tab was attached to this clip window. Re-open the clipper from the page you want to capture.",
            );
            return;
        }

        try {
            setStatus("loading");
            setErrorMessage("");

            const response = (await browser.tabs.sendMessage(
                targetSourceTabId,
                createClipperExtractMessage(),
            )) as ClipperExtractResponse | undefined;

            if (!response) {
                throw new Error("The source tab did not return any clip data.");
            }

            if (!response.ok) {
                throw new Error(response.error);
            }

            setClipData(response.data);
            setTitle(response.data.metadata.title);
            setTags(parseTagInput(response.data.metadata.domain));
            setContentMode(response.data.selection ? "selection" : "full-page");
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

    useEffect(() => {
        if (selectionOnly) {
            setContentMode("selection");
        }
    }, [selectionOnly]);

    useEffect(() => {
        setFolder(activeVault?.defaultFolder ?? "");
    }, [activeVault?.defaultFolder, activeVault?.id]);

    useEffect(() => {
        let cancelled = false;

        async function loadDesktopAutocomplete() {
            if (!activeVault) {
                return;
            }

            try {
                const context = await fetchDesktopContext({
                    vaultPathHint: activeVault.path,
                    vaultNameHint: activeVault.name,
                });
                if (cancelled) {
                    return;
                }

                setDesktopApiAvailable(context.available);
                setDesktopStatus(context.statusMessage);
                setDesktopFolders(context.folders);
                setDesktopTags(context.tags);
                setDesktopThemes(context.themes);
            } catch (error) {
                if (cancelled) {
                    return;
                }

                setDesktopApiAvailable(false);
                setDesktopStatus(
                    error instanceof DesktopApiError
                        ? error.message
                        : "Desktop API unavailable",
                );
                setDesktopFolders([]);
                setDesktopTags([]);
                setDesktopThemes([]);
            }
        }

        void loadDesktopAutocomplete();

        return () => {
            cancelled = true;
        };
    }, [activeVault?.id, activeVault?.name, activeVault?.path]);

    const tagSuggestions = useMemo(() => {
        if (!settings) {
            return [];
        }

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
        if (!settings || !activeVault) {
            return [];
        }

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
              );
    const deferredPreviewMarkdown = useDeferredValue(previewMarkdown);

    const settingsResolvedTemplate =
        clipData === null || settingsDraft === null || activeVault === null
            ? null
            : resolveClipTemplate({
                  templates: settingsDraft.templates,
                  defaultTemplate: settingsDraft.defaultTemplate,
                  vaultId: activeVault.id,
                  domain: clipData.metadata.domain,
              });

    const settingsPreviewMarkdown =
        clipData === null || settingsResolvedTemplate === null
            ? ""
            : buildMarkdownPreview(
                  clipData,
                  title,
                  tags,
                  folder,
                  contentMode,
                  settingsResolvedTemplate.body,
              );
    const deferredSettingsPreviewMarkdown = useDeferredValue(
        settingsPreviewMarkdown,
    );

    const vaultOptions =
        settings?.vaults.map((vault) => ({
            value: vault.id,
            label: vault.name,
        })) ?? [];

    async function handleActiveVaultChange(vaultId: string) {
        if (!settings) {
            return;
        }

        const nextIndex = settings.vaults.findIndex(
            (vault) => vault.id === vaultId,
        );
        if (nextIndex < 0) {
            return;
        }

        await persistSettings({
            ...settings,
            activeVaultIndex: nextIndex,
        });
    }

    function handleOpenSettings() {
        setSettingsDraft(settings);
        setSettingsSaveLabel("Save settings");
        setView("settings");
    }

    function handleCloseSettings() {
        setSettingsDraft(settings);
        setSettingsSaveLabel("Save settings");
        setView("clip");
    }

    async function handleSaveSettings() {
        if (!settingsDraft) {
            return;
        }

        setSettingsSaveLabel("Saving...");
        try {
            await persistSettings(settingsDraft);
            setSettingsSaveLabel("Saved");
            setView("clip");
        } catch (error) {
            setSettingsSaveLabel("Retry save");
            setSendMessage(extractErrorMessage(error));
        }
    }

    async function handleSendToVaultAi() {
        if (
            clipData === null ||
            settings === null ||
            activeVault === null ||
            resolvedTemplate === null
        ) {
            return;
        }

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

                const persistedSettings = recordClipHistory(nextSettings, {
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
                setSettings(persistedSettings);
                setSettingsDraft(persistedSettings);
                void saveClipperSettings(persistedSettings);
                setLastDeepLink("");
                setSendStatus("sent");
                setSendMessage(response.message);
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
                    vault: activeVault.id,
                    folder: normalizedFolder,
                    preferClipboard: settings.useClipboard,
                });

                if (draft.clipboardMarkdown !== null) {
                    await writeClipboardText(draft.clipboardMarkdown);
                }

                const persistedSettings = recordClipHistory(nextSettings, {
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
                setSettings(persistedSettings);
                setSettingsDraft(persistedSettings);
                void saveClipperSettings(persistedSettings);

                const deepLink = createClipDeepLink(draft.payload);
                setLastDeepLink(deepLink);
                setDesktopApiAvailable(false);
                openDeepLink(deepLink);
                setSendStatus("sent");
                setSendMessage(
                    draft.payload.mode === "clipboard"
                        ? "Desktop API unavailable. Prepared clipboard bridge handoff instead."
                        : "Desktop API unavailable. Prepared deep link handoff instead.",
                );
            }
        } catch (error) {
            setSendStatus("error");
            setSendMessage(extractErrorMessage(error));
        }
    }

    return (
        <main className="min-h-screen bg-surface text-fg">
            <div
                className={`mx-auto flex min-h-screen w-full flex-col gap-8 px-6 py-6 ${
                    surface === "sidepanel" ? "max-w-[860px]" : "max-w-[1400px]"
                }`}
            >
                <header className="clipper-fade-up flex flex-wrap items-start justify-between gap-5">
                    <div className="space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                            {surface === "sidepanel"
                                ? "VaultAI Side Panel"
                                : "VaultAI Web Clipper"}
                        </p>
                        <div className="space-y-2">
                            <h1 className="text-4xl font-semibold tracking-tight text-fg">
                                {surface === "sidepanel"
                                    ? "Review clips without leaving the page."
                                    : "Capture, review, and refine before you save."}
                            </h1>
                            <p className="max-w-3xl text-sm leading-7 text-fg-muted">
                                {surface === "sidepanel"
                                    ? "The same clipper workflow, pinned into Chrome's side panel so you can keep the source page visible while editing."
                                    : "This standalone window loads data from the original browser tab, lets you switch between full page, selection, or URL-only capture, and previews the Markdown that will flow into VaultAI."}
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <div className="rounded-[10px] border border-edge bg-surface-alt px-4 py-3 text-right shadow-soft">
                            <div className="text-xs uppercase tracking-wider text-fg-muted">
                                Source tab
                            </div>
                            <div className="mt-1 text-sm font-medium text-fg">
                                {sourceTabId === null
                                    ? "Unavailable"
                                    : `#${sourceTabId}`}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => setView("history")}
                            className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface-alt px-4 text-sm font-semibold text-fg transition hover:bg-surface-hover"
                        >
                            History
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void loadClipData();
                            }}
                            className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface-alt px-4 text-sm font-semibold text-fg transition hover:border-accent/35 hover:bg-surface-hover"
                        >
                            Reload extraction
                        </button>
                    </div>
                </header>

                {(settings === null ||
                    !sourceTabResolved ||
                    status === "loading") && <LoadingState />}

                {settings !== null &&
                    view === "settings" &&
                    settingsDraft !== null && (
                        <SettingsPage
                            settings={settingsDraft}
                            onChange={setSettingsDraft}
                            onClose={handleCloseSettings}
                            onSave={() => {
                                void handleSaveSettings();
                            }}
                            saveStateLabel={settingsSaveLabel}
                            templatePreview={deferredSettingsPreviewMarkdown}
                            vaultOptions={vaultOptions}
                        />
                    )}

                {settings !== null && view === "history" && (
                    <HistoryPage
                        history={settings.clipHistory}
                        onBack={() => setView("clip")}
                        onReuse={(entry) => {
                            setClipData({
                                metadata: entry.metadata,
                                content: {
                                    html: "",
                                    markdown: entry.markdown,
                                    wordCount: entry.markdown
                                        .trim()
                                        .split(/\s+/).length,
                                },
                                selection: null,
                                extractedAt: entry.createdAt,
                            });
                            setTitle(entry.title);
                            setTags(entry.tags);
                            setFolder(entry.folder);
                            setContentMode(entry.contentMode);
                            setSendStatus("idle");
                            setSendMessage("");
                            setLastDeepLink("");
                            setStatus("ready");
                            setView("clip");
                        }}
                        onDelete={(entryId) => {
                            if (!settings) {
                                return;
                            }

                            const nextSettings = {
                                ...settings,
                                clipHistory: settings.clipHistory.filter(
                                    (entry) => entry.id !== entryId,
                                ),
                            };
                            setSettings(nextSettings);
                            setSettingsDraft(nextSettings);
                            void saveClipperSettings(nextSettings);
                        }}
                    />
                )}

                {settings !== null && view === "clip" && status === "error" && (
                    <ErrorState
                        errorMessage={errorMessage}
                        onRetry={() => {
                            void loadClipData();
                        }}
                    />
                )}

                {settings !== null &&
                    view === "clip" &&
                    status === "ready" &&
                    clipData !== null && (
                        <>
                            <section
                                className={`grid gap-6 ${
                                    surface === "sidepanel"
                                        ? "xl:grid-cols-1"
                                        : "lg:grid-cols-[1.1fr_0.9fr]"
                                }`}
                            >
                                <div className="grid gap-6">
                                    <section className="clipper-fade-up rounded-xl border border-edge bg-surface-alt p-6 shadow-soft">
                                        <div className="flex flex-wrap items-start justify-between gap-4">
                                            <div className="space-y-2">
                                                <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                                                    Source
                                                </p>
                                                <h2 className="text-xl font-semibold text-fg">
                                                    {clipData.metadata.title}
                                                </h2>
                                            </div>
                                            <a
                                                href={clipData.metadata.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="inline-flex h-10 items-center justify-center rounded-[10px] border border-edge bg-surface-alt px-4 text-sm font-medium text-fg-muted transition hover:border-accent/35 hover:text-fg"
                                            >
                                                Open source
                                            </a>
                                        </div>

                                        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                            <div className="rounded-[10px] border border-edge bg-surface-raised p-4">
                                                <div className="text-xs uppercase tracking-wider text-fg-muted">
                                                    Domain
                                                </div>
                                                <div className="mt-2 text-sm font-medium text-fg">
                                                    {clipData.metadata.domain ||
                                                        "Unknown"}
                                                </div>
                                            </div>
                                            <div className="rounded-[10px] border border-edge bg-surface-raised p-4">
                                                <div className="text-xs uppercase tracking-wider text-fg-muted">
                                                    Author
                                                </div>
                                                <div className="mt-2 text-sm font-medium text-fg">
                                                    {clipData.metadata.author ||
                                                        "Unknown"}
                                                </div>
                                            </div>
                                            <div className="rounded-[10px] border border-edge bg-surface-raised p-4">
                                                <div className="text-xs uppercase tracking-wider text-fg-muted">
                                                    Published
                                                </div>
                                                <div className="mt-2 text-sm font-medium text-fg">
                                                    {clipData.metadata
                                                        .published || "Unknown"}
                                                </div>
                                            </div>
                                            <div className="rounded-[10px] border border-edge bg-surface-raised p-4">
                                                <div className="text-xs uppercase tracking-wider text-fg-muted">
                                                    Words
                                                </div>
                                                <div className="mt-2 text-sm font-medium text-fg">
                                                    {clipData.content.wordCount}
                                                </div>
                                            </div>
                                        </div>

                                        {clipData.metadata.description && (
                                            <p className="mt-5 text-sm leading-7 text-fg-muted">
                                                {clipData.metadata.description}
                                            </p>
                                        )}
                                    </section>

                                    <ClipForm
                                        clipData={clipData}
                                        contentMode={contentMode}
                                        selectionOnly={selectionOnly}
                                        onContentModeChange={setContentMode}
                                        title={title}
                                        onTitleChange={setTitle}
                                        tags={tags}
                                        tagSuggestions={tagSuggestions}
                                        onTagsChange={setTags}
                                        folder={folder}
                                        folderSuggestions={folderSuggestions}
                                        onFolderChange={setFolder}
                                    />
                                </div>

                                <MarkdownPreview
                                    contentMode={contentMode}
                                    markdown={deferredPreviewMarkdown}
                                />
                            </section>

                            <footer className="clipper-fade-up flex flex-wrap items-center justify-between gap-4 rounded-xl border border-edge bg-surface-alt px-6 py-5 shadow-soft">
                                <div className="flex flex-wrap items-center gap-4">
                                    <VaultSelector
                                        value={activeVault?.id ?? ""}
                                        options={vaultOptions}
                                        onChange={(value) => {
                                            void handleActiveVaultChange(value);
                                        }}
                                    />
                                    <SettingsButton
                                        onClick={handleOpenSettings}
                                    />
                                </div>

                                <div className="flex flex-wrap items-center gap-4">
                                    <div className="max-w-lg text-right">
                                        <p className="text-xs leading-6 text-fg-muted">
                                            `vault` and `folder` are sent only
                                            as hints. The desktop app must
                                            revalidate the final target before
                                            writing anything to disk.
                                        </p>
                                        <p className="mt-1 text-xs leading-6 text-fg-muted">
                                            Folder hint:{" "}
                                            {normalizeFolderHint(folder) ||
                                                "None"}{" "}
                                            · Transport:{" "}
                                            {settings.useClipboard
                                                ? "clipboard preferred"
                                                : "desktop API when available"}
                                        </p>
                                        <p className="mt-1 text-xs leading-6 text-fg-muted">
                                            Template:{" "}
                                            {resolvedTemplate?.name ??
                                                "Default"}{" "}
                                            · Desktop: {desktopStatus} · Themes:{" "}
                                            {desktopThemes.length}
                                        </p>
                                        {sendMessage && (
                                            <p
                                                className={`mt-2 text-xs leading-6 ${
                                                    sendStatus === "error"
                                                        ? "text-rose-200"
                                                        : "text-accent"
                                                }`}
                                            >
                                                {sendMessage}
                                            </p>
                                        )}
                                        {lastDeepLink && (
                                            <p className="mt-2 truncate text-[11px] leading-6 text-fg-muted">
                                                {lastDeepLink}
                                            </p>
                                        )}
                                    </div>
                                    <SaveButton
                                        disabled={sendStatus === "sending"}
                                        status={sendStatus}
                                        onClick={() => {
                                            void handleSendToVaultAi();
                                        }}
                                    />
                                </div>
                            </footer>
                        </>
                    )}
            </div>
        </main>
    );
}

export default App;
