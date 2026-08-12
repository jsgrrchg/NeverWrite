import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
    safeStorageGetItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "../../../app/utils/safeStorage";
import type { ConversationProviderPickerOption } from "../conversationPickerModel";
import { AIProviderIcon } from "./AIProviderIcon";
import { useAnchoredChatMenuPosition } from "./useAnchoredChatMenuPosition";

interface AIProviderModelPickerProps {
    disabled?: boolean;
    runtimeId: string;
    modelId: string;
    providers: ConversationProviderPickerOption[];
    onChange: (runtimeId: string, modelId: string) => void;
    onProviderActivate?: (runtimeId: string) => void | Promise<void>;
}

interface FavoriteModel {
    runtimeId: string;
    modelId: string;
}

interface PickerModel {
    key: string;
    runtimeId: string;
    providerLabel: string;
    modelId: string;
    modelLabel: string;
    description: string;
    providerDisabledReason: string | null;
    disabledReason: string | null;
}

const FAVORITE_MODELS_STORAGE_KEY =
    "neverwrite.ai.provider-model-picker-favorites";
const FAVORITES_PROVIDER_ID = "__favorites__";

function modelKey(runtimeId: string, modelId: string) {
    return `${runtimeId}\u0000${modelId}`;
}

function readFavoriteModels(): FavoriteModel[] {
    try {
        const value = JSON.parse(
            safeStorageGetItem(FAVORITE_MODELS_STORAGE_KEY) ?? "[]",
        );
        if (!Array.isArray(value)) return [];
        return value.filter(
            (item): item is FavoriteModel =>
                typeof item === "object" &&
                item !== null &&
                typeof item.runtimeId === "string" &&
                typeof item.modelId === "string",
        );
    } catch {
        return [];
    }
}

function SearchIcon() {
    return (
        <svg
            aria-hidden="true"
            className="shrink-0 opacity-50"
            fill="none"
            height="14"
            viewBox="0 0 16 16"
            width="14"
        >
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
            <path
                d="m10.5 10.5 3 3"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.5"
            />
        </svg>
    );
}

function StarIcon({ filled = false }: { filled?: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill={filled ? "currentColor" : "none"}
            height="14"
            viewBox="0 0 16 16"
            width="14"
        >
            <path
                d="m8 1.75 1.82 3.69 4.07.59-2.95 2.87.7 4.06L8 11.05l-3.64 1.91.7-4.06L2.1 6.03l4.08-.59L8 1.75Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.25"
            />
        </svg>
    );
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="10"
            style={{
                opacity: 0.5,
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform 0.1s ease",
            }}
            viewBox="0 0 10 10"
            width="10"
        >
            <path
                d="M2.5 4 5 6.5 7.5 4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
            />
        </svg>
    );
}

function fallbackModels(
    provider: ConversationProviderPickerOption,
    loadingProviderId: string | null,
) {
    if (provider.runtimeId === loadingProviderId) {
        return [
            {
                modelId: "__loading__",
                label: "Loading models…",
                description: `Connecting to ${provider.label} to discover its available models.`,
                disabledReason: "Models are still loading.",
            },
        ];
    }
    if (provider.models.length > 0) return provider.models;
    if (!provider.defaultModelId) {
        return [
            {
                modelId: "__discover__",
                label: "Load available models",
                description: `Connect to ${provider.label} to discover its available models.`,
                disabledReason: "Select the provider icon to load its models.",
            },
        ];
    }
    return [
        {
            modelId: provider.defaultModelId,
            label: "Default model",
            description: provider.description,
            disabledReason: null,
        },
    ];
}

export function AIProviderModelPicker({
    disabled = false,
    runtimeId,
    modelId,
    providers,
    onChange,
    onProviderActivate,
}: AIProviderModelPickerProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [selectedProviderId, setSelectedProviderId] = useState(runtimeId);
    const [favorites, setFavorites] = useState(readFavoriteModels);
    const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
    const [blockedProviderId, setBlockedProviderId] = useState<string | null>(
        null,
    );
    const [loadingProviderId, setLoadingProviderId] = useState<string | null>(
        null,
    );
    const rootRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const lastFocusedElementRef = useRef<HTMLElement | null>(null);

    const rows = useMemo<PickerModel[]>(
        () =>
            providers.flatMap((provider) =>
                fallbackModels(provider, loadingProviderId).map((model) => ({
                    key: modelKey(provider.runtimeId, model.modelId),
                    runtimeId: provider.runtimeId,
                    providerLabel: provider.label,
                    modelId: model.modelId,
                    modelLabel: model.label,
                    description: model.description ?? provider.description,
                    providerDisabledReason: provider.disabledReason,
                    disabledReason:
                        provider.disabledReason ?? model.disabledReason ?? null,
                })),
            ),
        [loadingProviderId, providers],
    );

    const activateProvider = (provider: ConversationProviderPickerOption) => {
        setSelectedProviderId(provider.runtimeId);
        setBlockedProviderId(null);
        searchInputRef.current?.focus();
        if (!onProviderActivate) return;

        setLoadingProviderId(provider.runtimeId);
        void Promise.resolve(onProviderActivate(provider.runtimeId)).finally(
            () => {
                setLoadingProviderId((current) =>
                    current === provider.runtimeId ? null : current,
                );
            },
        );
    };
    const favoriteKeys = useMemo(
        () =>
            new Set(
                favorites.map((favorite) =>
                    modelKey(favorite.runtimeId, favorite.modelId),
                ),
            ),
        [favorites],
    );
    const normalizedQuery = query.trim().toLowerCase();
    const visibleRows = useMemo(() => {
        if (normalizedQuery) {
            return rows.filter((row) =>
                [
                    row.modelLabel,
                    row.modelId,
                    row.providerLabel,
                    row.description,
                ].some((value) => value.toLowerCase().includes(normalizedQuery)),
            );
        }

        if (selectedProviderId === FAVORITES_PROVIDER_ID) {
            return rows.filter((row) => favoriteKeys.has(row.key));
        }
        return rows
            .filter((row) => row.runtimeId === selectedProviderId)
            .toSorted((left, right) => {
                const favoriteDelta =
                    Number(favoriteKeys.has(right.key)) -
                    Number(favoriteKeys.has(left.key));
                return favoriteDelta;
            });
    }, [favoriteKeys, normalizedQuery, rows, selectedProviderId]);
    const selectableRows = useMemo(
        () => visibleRows.filter((row) => !row.disabledReason),
        [visibleRows],
    );
    const selectedRow =
        rows.find(
            (row) => row.runtimeId === runtimeId && row.modelId === modelId,
        ) ?? rows.find((row) => row.runtimeId === runtimeId);
    const triggerLabel = selectedRow?.modelLabel ?? (modelId || "Model");
    const blockedProvider = providers.find(
        (provider) =>
            provider.runtimeId === blockedProviderId &&
            provider.disabledReason != null,
    );
    const menuPosition = useAnchoredChatMenuPosition(rootRef, menuRef, open);

    const restoreFocus = () => {
        const target = lastFocusedElementRef.current;
        if (target?.isConnected) target.focus();
    };
    const closePicker = (shouldRestoreFocus = false) => {
        setOpen(false);
        setQuery("");
        setHighlightedKey(null);
        setBlockedProviderId(null);
        if (shouldRestoreFocus) {
            window.requestAnimationFrame(restoreFocus);
        }
    };

    useEffect(() => {
        return subscribeSafeStorage((event) => {
            if (event.key === FAVORITE_MODELS_STORAGE_KEY) {
                setFavorites(readFavoriteModels());
            }
        });
    }, []);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (
                !rootRef.current?.contains(event.target as Node) &&
                !menuRef.current?.contains(event.target as Node)
            ) {
                setOpen(false);
                setQuery("");
                setHighlightedKey(null);
                setBlockedProviderId(null);
            }
        };
        document.addEventListener("mousedown", handlePointerDown);
        return () => document.removeEventListener("mousedown", handlePointerDown);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        setSelectedProviderId((current) =>
            current === FAVORITES_PROVIDER_ID && favorites.length === 0
                ? runtimeId
                : current,
        );
        const frame = window.requestAnimationFrame(() => {
            searchInputRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [favorites.length, open, runtimeId]);

    useEffect(() => {
        if (!open) return;
        const preferred = selectableRows.find(
            (row) => row.runtimeId === runtimeId && row.modelId === modelId,
        );
        setHighlightedKey(preferred?.key ?? selectableRows[0]?.key ?? null);
    }, [modelId, normalizedQuery, open, selectedProviderId, selectableRows, runtimeId]);

    const toggleFavorite = (row: PickerModel) => {
        const next = favoriteKeys.has(row.key)
            ? favorites.filter(
                  (favorite) =>
                      favorite.runtimeId !== row.runtimeId ||
                      favorite.modelId !== row.modelId,
              )
            : [
                  ...favorites,
                  { runtimeId: row.runtimeId, modelId: row.modelId },
              ];
        setFavorites(next);
        safeStorageSetItem(FAVORITE_MODELS_STORAGE_KEY, JSON.stringify(next));
    };

    const selectRow = (row: PickerModel) => {
        if (row.providerDisabledReason) {
            setBlockedProviderId(row.runtimeId);
            return;
        }
        if (row.disabledReason) return;
        onChange(row.runtimeId, row.modelId);
        closePicker(true);
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            const highlighted = selectableRows.find(
                (row) => row.key === highlightedKey,
            );
            if (highlighted) {
                event.preventDefault();
                selectRow(highlighted);
            }
            return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const currentIndex = selectableRows.findIndex(
            (row) => row.key === highlightedKey,
        );
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
            currentIndex < 0
                ? direction > 0
                    ? 0
                    : selectableRows.length - 1
                : (currentIndex + direction + selectableRows.length) %
                  selectableRows.length;
        setHighlightedKey(selectableRows[nextIndex]?.key ?? null);
    };

    return (
        <div className="relative" ref={rootRef}>
            <button
                aria-expanded={open}
                aria-haspopup="dialog"
                className="nw-control-trigger flex max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                data-open={open ? "true" : undefined}
                disabled={disabled || rows.length === 0}
                onClick={() => {
                    if (disabled || rows.length === 0) return;
                    if (open) {
                        closePicker(true);
                        return;
                    }
                    const activeElement = document.activeElement;
                    if (activeElement instanceof HTMLElement) {
                        lastFocusedElementRef.current = activeElement;
                    }
                    setSelectedProviderId(
                        favorites.length > 0 ? FAVORITES_PROVIDER_ID : runtimeId,
                    );
                    setOpen(true);
                }}
                onMouseDown={(event) => {
                    if (!disabled) event.preventDefault();
                }}
                style={{
                    backgroundColor: "transparent",
                    border: "none",
                    color: "var(--text-secondary)",
                    opacity: disabled ? 0.45 : 1,
                }}
                title="Provider and model"
                type="button"
            >
                <AIProviderIcon runtimeId={runtimeId} size={14} />
                <span className="min-w-0 truncate">{triggerLabel}</span>
                <ChevronIcon open={open} />
            </button>

            {open
                ? createPortal(
                <div
                    aria-label="Provider and model"
                    className="nw-chat-glass-menu fixed z-50 flex h-[346px] max-h-[min(346px,calc(100vh-32px))] w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl"
                    ref={menuRef}
                    role="dialog"
                    style={{
                        border: "1px solid var(--border)",
                        boxShadow: "0 18px 42px rgba(0,0,0,0.24)",
                        color: "var(--text-primary)",
                        left: menuPosition?.left ?? 8,
                        top: menuPosition?.top ?? 8,
                        visibility: menuPosition ? "visible" : "hidden",
                    }}
                >
                    {!normalizedQuery ? (
                        <div
                            aria-label="Providers"
                            className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto p-1"
                            style={{
                                backgroundColor:
                                    "color-mix(in srgb, var(--bg-tertiary) 55%, transparent)",
                                borderRight: "1px solid var(--border)",
                            }}
                        >
                            <button
                                aria-label="Favorites"
                                aria-pressed={
                                    selectedProviderId === FAVORITES_PROVIDER_ID
                                }
                                className="relative flex aspect-square w-full items-center justify-center rounded-md"
                                onClick={() => {
                                    setSelectedProviderId(FAVORITES_PROVIDER_ID);
                                    setBlockedProviderId(null);
                                    searchInputRef.current?.focus();
                                }}
                                style={{
                                    backgroundColor:
                                        selectedProviderId === FAVORITES_PROVIDER_ID
                                            ? "var(--bg-primary)"
                                            : "transparent",
                                    border: "none",
                                    color: "var(--text-primary)",
                                }}
                                title="Favorites"
                                type="button"
                            >
                                <StarIcon filled />
                            </button>
                            <div
                                aria-hidden="true"
                                className="mx-1 h-px w-7 shrink-0"
                                style={{ backgroundColor: "var(--border)" }}
                            />
                            {providers.map((provider) => {
                                const selected =
                                    selectedProviderId === provider.runtimeId;
                                const providerLocked =
                                    provider.runtimeId !== runtimeId &&
                                    provider.disabledReason != null;
                                const providerCanDiscoverModels =
                                    onProviderActivate != null &&
                                    provider.models.length === 0 &&
                                    !provider.defaultModelId;
                                return (
                                    <button
                                        aria-disabled={providerLocked || undefined}
                                        aria-label={provider.label}
                                        aria-pressed={selected}
                                        className={`relative flex aspect-square w-full items-center justify-center rounded-md ${providerLocked ? "cursor-not-allowed" : ""}`}
                                        disabled={
                                            provider.models.length === 0 &&
                                            !provider.defaultModelId &&
                                            !providerCanDiscoverModels
                                        }
                                        key={provider.runtimeId}
                                        onClick={() => {
                                            if (providerLocked) {
                                                setBlockedProviderId(
                                                    provider.runtimeId,
                                                );
                                                searchInputRef.current?.focus();
                                                return;
                                            }
                                            activateProvider(provider);
                                        }}
                                        style={{
                                            backgroundColor: selected
                                                ? "var(--bg-primary)"
                                                : "transparent",
                                            border: "none",
                                            color: "var(--text-primary)",
                                            opacity:
                                                provider.models.length === 0 &&
                                                !provider.defaultModelId &&
                                                !providerCanDiscoverModels
                                                    ? 0.4
                                                    : providerLocked
                                                      ? 0.45
                                                      : 1,
                                        }}
                                        title={
                                            providerLocked
                                                ? provider.disabledReason ?? provider.label
                                                : provider.label
                                        }
                                        type="button"
                                    >
                                        <AIProviderIcon
                                            className="shrink-0 opacity-80"
                                            runtimeId={provider.runtimeId}
                                            size={19}
                                        />
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}

                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="px-2 pt-2">
                            <div
                                className="flex h-9 items-center gap-2 border-b px-1"
                                style={{ borderColor: "var(--border)" }}
                            >
                                <SearchIcon />
                                <input
                                    aria-label="Provider and model search"
                                    className="h-full min-w-0 flex-1 bg-transparent p-0 text-sm leading-none outline-none"
                                    onChange={(event) => setQuery(event.target.value)}
                                    onKeyDown={handleSearchKeyDown}
                                    placeholder="Search models..."
                                    ref={searchInputRef}
                                    style={{
                                        border: "none",
                                        color: "var(--text-primary)",
                                        fontFamily: "inherit",
                                        fontSize: "0.875rem",
                                    }}
                                    type="text"
                                    value={query}
                                />
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto p-2">
                            {visibleRows.length === 0 ? (
                                <div
                                    className="px-2 py-8 text-center text-xs"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {selectedProviderId === FAVORITES_PROVIDER_ID &&
                                    !normalizedQuery
                                        ? "No favorite models yet. Star a model to keep it here."
                                        : "No providers or models match that search."}
                                </div>
                            ) : (
                                <div className="flex flex-col gap-0.5">
                                    {visibleRows.map((row) => {
                                        const favorite = favoriteKeys.has(row.key);
                                        const selected =
                                            row.runtimeId === runtimeId &&
                                            row.modelId === modelId;
                                        const highlighted =
                                            row.key === highlightedKey;
                                        const providerLocked =
                                            row.runtimeId !== runtimeId &&
                                            row.providerDisabledReason != null;
                                        const rowTitle =
                                            row.disabledReason ?? row.description;
                                        return (
                                            <div
                                                className="group flex min-w-0 items-center rounded-lg px-1"
                                                key={row.key}
                                                onMouseEnter={() =>
                                                    !row.disabledReason &&
                                                    setHighlightedKey(row.key)
                                                }
                                                style={{
                                                    backgroundColor:
                                                        highlighted || selected
                                                            ? "var(--bg-tertiary)"
                                                            : "transparent",
                                                    opacity:
                                                        row.disabledReason ||
                                                        providerLocked
                                                            ? 0.45
                                                            : 1,
                                                }}
                                                title={rowTitle}
                                            >
                                                <button
                                                    aria-disabled={
                                                        row.disabledReason != null || undefined
                                                    }
                                                    aria-current={
                                                        selected ? "true" : undefined
                                                    }
                                                    aria-label={`${row.providerLabel} · ${row.modelLabel}`}
                                                    className={`min-w-0 flex-1 px-1.5 py-2 text-left ${providerLocked ? "cursor-not-allowed" : ""}`}
                                                    disabled={
                                                        row.disabledReason != null &&
                                                        row.providerDisabledReason == null
                                                    }
                                                    onClick={() => selectRow(row)}
                                                    style={{
                                                        backgroundColor: "transparent",
                                                        border: "none",
                                                        color: "var(--text-primary)",
                                                    }}
                                                    title={rowTitle}
                                                    type="button"
                                                >
                                                    <span className="block truncate text-xs font-medium">
                                                        {row.modelLabel}
                                                    </span>
                                                    <span
                                                        className="mt-1 flex items-center gap-1.5 truncate text-[11px]"
                                                        style={{
                                                            color: "var(--text-secondary)",
                                                        }}
                                                    >
                                                        <AIProviderIcon
                                                            runtimeId={row.runtimeId}
                                                            size={11}
                                                        />
                                                        {row.providerLabel}
                                                    </span>
                                                </button>
                                                <button
                                                    aria-label={
                                                        favorite
                                                            ? `Remove ${row.modelLabel} from favorites`
                                                            : `Add ${row.modelLabel} to favorites`
                                                    }
                                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                                                    disabled={row.disabledReason != null}
                                                    onClick={() => toggleFavorite(row)}
                                                    style={{
                                                        backgroundColor: "transparent",
                                                        border: "none",
                                                        color: favorite
                                                            ? "#eab308"
                                                            : "var(--text-secondary)",
                                                        opacity: favorite ? 1 : 0.65,
                                                    }}
                                                    title={
                                                        favorite
                                                            ? "Remove from favorites"
                                                            : "Add to favorites"
                                                    }
                                                    type="button"
                                                >
                                                    <StarIcon filled={favorite} />
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    {blockedProvider ? (
                        <div
                            aria-live="polite"
                            className="pointer-events-none absolute bottom-2 left-12 z-20 max-w-64 rounded-md px-2.5 py-2 text-xs leading-snug"
                            data-testid="provider-selection-blocked-popover"
                            role="status"
                            style={{
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--border)",
                                boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
                                color: "var(--text-primary)",
                            }}
                        >
                            <span
                                aria-hidden="true"
                                className="absolute top-1/2 -left-1 size-2 -translate-y-1/2 rotate-45"
                                style={{
                                    backgroundColor: "var(--bg-primary)",
                                    borderBottom: "1px solid var(--border)",
                                    borderLeft: "1px solid var(--border)",
                                }}
                            />
                            {blockedProvider.disabledReason}
                        </div>
                    ) : null}
                </div>,
                document.body,
                )
                : null}
        </div>
    );
}
