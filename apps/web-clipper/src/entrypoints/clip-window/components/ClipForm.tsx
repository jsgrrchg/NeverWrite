import type { ClipData } from "../../../lib/clipper-contract";
import FolderSelector from "./FolderSelector";
import TagEditor from "./TagEditor";

export type ClipContentMode = "full-page" | "selection" | "url-only";

interface ClipFormProps {
    clipData: ClipData;
    contentMode: ClipContentMode;
    selectionOnly?: boolean;
    onContentModeChange: (mode: ClipContentMode) => void;
    title: string;
    onTitleChange: (value: string) => void;
    tags: string[];
    tagSuggestions: string[];
    onTagsChange: (value: string[]) => void;
    folder: string;
    folderSuggestions: string[];
    onFolderChange: (value: string) => void;
}

export function ClipForm({
    clipData,
    contentMode,
    selectionOnly = false,
    onContentModeChange,
    title,
    onTitleChange,
    tags,
    tagSuggestions,
    onTagsChange,
    folder,
    folderSuggestions,
    onFolderChange,
}: ClipFormProps) {
    const hasSelection = clipData.selection !== null;

    return (
        <section className="clipper-fade-up rounded-xl border border-edge bg-surface-alt p-6 shadow-soft">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                        Clip details
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-fg">
                        Review before sending to VaultAI
                    </h2>
                </div>
                {hasSelection ? (
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/12 px-3 py-1 text-xs font-medium text-fg">
                        Selection detected
                    </span>
                ) : (
                    <span className="rounded-full border border-edge bg-surface-raised px-3 py-1 text-xs font-medium text-fg-muted">
                        Full page capture
                    </span>
                )}
            </div>

            <div className="mt-6 grid gap-5">
                <label className="grid gap-2">
                    <span className="text-sm font-medium text-fg">Title</span>
                    <input
                        value={title}
                        onChange={(event) => onTitleChange(event.target.value)}
                        placeholder="Untitled clip"
                        className="h-11 rounded-[10px] border border-edge bg-surface-raised px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                    />
                </label>

                <FolderSelector
                    value={folder}
                    suggestions={folderSuggestions}
                    onChange={onFolderChange}
                />

                <label className="grid gap-2">
                    <span className="text-sm font-medium text-fg">Tags</span>
                    <TagEditor
                        tags={tags}
                        suggestions={tagSuggestions}
                        onChange={onTagsChange}
                    />
                </label>

                <fieldset className="grid gap-3">
                    <legend className="text-sm font-medium text-fg">
                        Content mode
                    </legend>
                    <div className="grid gap-3 md:grid-cols-3">
                        <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-edge bg-surface-raised p-4">
                            <input
                                type="radio"
                                name="content-mode"
                                checked={contentMode === "full-page"}
                                onChange={() =>
                                    onContentModeChange("full-page")
                                }
                                disabled={selectionOnly}
                                className="mt-1 h-4 w-4"
                            />
                            <span className="grid gap-1">
                                <span className="text-sm font-medium text-fg">
                                    Full page
                                </span>
                                <span className="text-xs leading-5 text-fg-muted">
                                    Use the cleaned article content from
                                    Defuddle.
                                </span>
                            </span>
                        </label>

                        <label
                            className={`flex items-start gap-3 rounded-[10px] border p-4 ${
                                hasSelection
                                    ? "cursor-pointer border-emerald-400/20 bg-emerald-400/8"
                                    : "cursor-not-allowed border-edge bg-surface opacity-55"
                            }`}
                        >
                            <input
                                type="radio"
                                name="content-mode"
                                checked={contentMode === "selection"}
                                onChange={() =>
                                    onContentModeChange("selection")
                                }
                                disabled={!hasSelection}
                                className="mt-1 h-4 w-4"
                            />
                            <span className="grid gap-1">
                                <span className="text-sm font-medium text-fg">
                                    Selection
                                </span>
                                <span className="text-xs leading-5 text-fg-muted">
                                    Prefer the current text selection when
                                    available.
                                </span>
                            </span>
                        </label>

                        <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-edge bg-surface-raised p-4">
                            <input
                                type="radio"
                                name="content-mode"
                                checked={contentMode === "url-only"}
                                onChange={() => onContentModeChange("url-only")}
                                disabled={selectionOnly}
                                className="mt-1 h-4 w-4"
                            />
                            <span className="grid gap-1">
                                <span className="text-sm font-medium text-fg">
                                    URL only
                                </span>
                                <span className="text-xs leading-5 text-fg-muted">
                                    Save a lightweight bookmark with source
                                    context.
                                </span>
                            </span>
                        </label>
                    </div>
                </fieldset>
            </div>
        </section>
    );
}

export default ClipForm;
