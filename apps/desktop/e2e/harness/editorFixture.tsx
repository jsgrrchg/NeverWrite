import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import "./chat.css";
import { Editor } from "../../src/features/editor/Editor";
import { useEditorStore, type TabInput } from "../../src/app/store/editorStore";
import { useSettingsStore } from "../../src/app/store/settingsStore";
import { useVaultStore } from "../../src/app/store/vaultStore";

function getView() {
    const dom = document.querySelector<HTMLElement>(".cm-editor");
    const view = dom && EditorView.findFromDOM(dom);
    if (!view) throw new Error("Editor is not mounted");
    return view;
}

const root = createRoot(document.getElementById("root")!);
let mountId = 0;

const editorFixture = {
    mount(tabs: TabInput[], preview = true) {
        useSettingsStore.setState({ livePreviewEnabled: preview });
        useVaultStore.setState({ vaultPath: "/fixture", notes: [], entries: [] });
        useEditorStore.getState().hydrateTabs(tabs, tabs[0]?.id ?? null);
        root.render(
            <div key={++mountId} style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
                <nav>
                    {tabs.map((tab) => (
                        <button key={tab.id} onClick={() => useEditorStore.getState().switchTab(tab.id!)}>
                            {tab.title}
                        </button>
                    ))}
                </nav>
                <Editor />
            </div>,
        );
    },
    getView,
    snapshot() {
        const view = getView();
        const bounds = view.scrollDOM.getBoundingClientRect();
        const visible = Array.from(view.contentDOM.children).filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        return {
            docLength: view.state.doc.length,
            parsedLength: syntaxTree(view.state).length,
            viewport: view.viewport,
            visibleRanges: view.visibleRanges,
            scrollTop: view.scrollDOM.scrollTop,
            scrollHeight: view.scrollDOM.scrollHeight,
            clientHeight: view.scrollDOM.clientHeight,
            contentBounds: view.contentDOM.getBoundingClientRect().toJSON(),
            bounds: bounds.toJSON(),
            hasFocus: view.hasFocus,
            selection: view.state.selection.toJSON(),
            visible: visible.map((element) => ({
                className: element.className,
                text: element.textContent,
                bounds: element.getBoundingClientRect().toJSON(),
            })),
            html: view.contentDOM.innerHTML,
        };
    },
};

declare global {
    interface Window {
        editorFixture: typeof editorFixture;
    }
}
window.editorFixture = editorFixture;
