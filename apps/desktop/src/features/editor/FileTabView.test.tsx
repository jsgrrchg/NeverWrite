import { act, fireEvent, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import userEvent from "@testing-library/user-event";
import { openPath } from "@tauri-apps/plugin-opener";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useChatStore } from "../ai/store/chatStore";
import {
  buildPatchFromTexts,
  buildTextRangePatchFromTexts,
  emptyActionLogState,
  setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import { FileTabView } from "./FileTabView";
import {
  mockInvoke,
  renderComponent,
  setEditorTabs,
  setVaultEntries,
} from "../../test/test-utils";

function seedTrackedDiff(
  targetPath: string,
  diffBase: string,
  currentText: string,
) {
  const workCycleId = "wc-inline-diff-file";
  const trackedFile: TrackedFile = {
    identityKey: targetPath,
    originPath: targetPath,
    path: targetPath,
    previousPath: null,
    status: { kind: "modified" },
    diffBase,
    currentText,
    unreviewedRanges: buildTextRangePatchFromTexts(diffBase, currentText),
    unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
    version: 1,
    isText: true,
    updatedAt: 1,
  };

  useChatStore.setState({
    sessionsById: {
      "session-inline-diff-file": {
        sessionId: "session-inline-diff-file",
        historySessionId: "session-inline-diff-file",
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
        actionLog: setTrackedFilesForWorkCycle(
          emptyActionLogState(),
          workCycleId,
          { [trackedFile.identityKey]: trackedFile },
        ),
        runtimeId: "test-runtime",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
      },
    },
    sessionOrder: ["session-inline-diff-file"],
    activeSessionId: "session-inline-diff-file",
  });
}

describe("FileTabView", () => {
  it("renders image files with native-first controls", async () => {
    const user = userEvent.setup();

    setEditorTabs([
      {
        id: "image-tab",
        kind: "file",
        relativePath: "assets/photo.webp",
        title: "photo.webp",
        path: "/vault/assets/photo.webp",
        mimeType: "image/webp",
        viewer: "image",
        content: "",
      },
    ]);

    renderComponent(<FileTabView />);

    expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Actual Size" }),
    ).toBeInTheDocument();
    expect(screen.getByAltText("photo.webp")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Externally" }));
    expect(vi.mocked(openPath)).toHaveBeenCalledWith(
      "/vault/assets/photo.webp",
    );
  });

  it("supports Command + wheel zoom from fit mode", () => {
    setEditorTabs([
      {
        id: "image-tab",
        kind: "file",
        relativePath: "assets/photo.webp",
        title: "photo.webp",
        path: "/vault/assets/photo.webp",
        mimeType: "image/webp",
        viewer: "image",
        content: "",
      },
    ]);

    const { container } = renderComponent(<FileTabView />);
    const scrollSurface = container.querySelector(
      "div[class*='overflow-auto']",
    ) as HTMLDivElement | null;
    const image = screen.getByAltText("photo.webp") as HTMLImageElement;

    expect(scrollSurface?.style.touchAction).toBe("pan-x pan-y pinch-zoom");
    expect(image.style.touchAction).toBe("pan-x pan-y pinch-zoom");

    fireEvent.keyDown(window, { key: "Meta" });
    fireEvent.wheel(scrollSurface!, { deltaY: -10 });
    fireEvent.keyUp(window, { key: "Meta" });

    expect(screen.getByText("102.5%")).toBeInTheDocument();
  });

  it("renders text files in an editable editor without preview", async () => {
    vi.useFakeTimers();
    setVaultEntries([]);
    setEditorTabs([
      {
        id: "text-tab",
        kind: "file",
        relativePath: "src/config.toml",
        title: "config.toml",
        path: "/vault/src/config.toml",
        mimeType: "application/toml",
        viewer: "text",
        content: 'name = "VaultAI"',
      },
    ]);

    renderComponent(<FileTabView />);

    const editorElement = document.querySelector(".cm-editor");
    expect(editorElement).not.toBeNull();
    expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(editorElement).toHaveAttribute("data-live-preview", "false");
    expect(screen.getByText('name = "VaultAI"')).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Fit" }),
    ).not.toBeInTheDocument();
    const view = EditorView.findFromDOM(editorElement as HTMLElement);
    expect(view).not.toBeNull();
    expect(view!.state.facet(EditorState.readOnly)).toBe(false);

    mockInvoke().mockResolvedValue({
      relative_path: "src/config.toml",
      file_name: "config.toml",
      content: 'name = "VaultAI"\nversion = "1.0.0"',
    });

    act(() => {
      view!.dispatch({
        changes: {
          from: view!.state.doc.length,
          insert: '\nversion = "1.0.0"',
        },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(mockInvoke()).toHaveBeenCalledWith("save_vault_file", {
      vaultPath: "/vault",
      relativePath: "src/config.toml",
      content: 'name = "VaultAI"\nversion = "1.0.0"',
    });
  });

  it("recreates the text editor and shows the next file immediately on tab switch", async () => {
    setEditorTabs(
      [
        {
          id: "text-tab-1",
          kind: "file",
          relativePath: "src/config.toml",
          title: "config.toml",
          path: "/vault/src/config.toml",
          mimeType: "application/toml",
          viewer: "text",
          content: 'name = "VaultAI"',
        },
        {
          id: "text-tab-2",
          kind: "file",
          relativePath: "src/next.toml",
          title: "next.toml",
          path: "/vault/src/next.toml",
          mimeType: "application/toml",
          viewer: "text",
          content: 'name = "Next"',
        },
      ],
      "text-tab-1",
    );

    renderComponent(<FileTabView />);

    const firstEditor = document.querySelector(".cm-editor");
    expect(firstEditor).not.toBeNull();
    const firstView = EditorView.findFromDOM(firstEditor as HTMLElement);
    expect(firstView).not.toBeNull();
    expect(firstView!.state.doc.toString()).toBe('name = "VaultAI"');

    await act(async () => {
      useEditorStore.getState().switchTab("text-tab-2");
    });

    const secondEditor = document.querySelector(".cm-editor");
    expect(secondEditor).not.toBeNull();
    const secondView = EditorView.findFromDOM(secondEditor as HTMLElement);
    expect(secondView).not.toBeNull();
    expect(secondView).not.toBe(firstView);
    expect(secondView!.state.doc.toString()).toBe('name = "Next"');
    expect(screen.getByText("next.toml")).toBeInTheDocument();
  });

  it("reapplies pending inline diff decorations when returning to a text file tab", async () => {
    setEditorTabs(
      [
        {
          id: "text-tab-1",
          kind: "file",
          relativePath: "src/config.toml",
          title: "config.toml",
          path: "/vault/src/config.toml",
          mimeType: "application/toml",
          viewer: "text",
          content: 'name = "VaultAI"',
        },
        {
          id: "text-tab-2",
          kind: "file",
          relativePath: "src/next.toml",
          title: "next.toml",
          path: "/vault/src/next.toml",
          mimeType: "application/toml",
          viewer: "text",
          content: 'name = "Next"',
        },
      ],
      "text-tab-1",
    );
    seedTrackedDiff(
      "/vault/src/config.toml",
      'name = "Old"',
      'name = "VaultAI"',
    );

    renderComponent(<FileTabView />);
    expect(
      document.querySelector(".cm-diff-inline-modified, .cm-diff-word-changed"),
    ).not.toBeNull();

    await act(async () => {
      useEditorStore.getState().switchTab("text-tab-2");
    });

    expect(
      document.querySelector(".cm-diff-inline-modified, .cm-diff-word-changed"),
    ).toBeNull();

    await act(async () => {
      useEditorStore.getState().switchTab("text-tab-1");
    });

    expect(
      document.querySelector(".cm-diff-inline-modified, .cm-diff-word-changed"),
    ).not.toBeNull();

    useChatStore.setState({
      sessionsById: {},
      sessionOrder: [],
      activeSessionId: null,
    });
  });
});
