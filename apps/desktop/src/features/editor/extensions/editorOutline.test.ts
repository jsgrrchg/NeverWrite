import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditorOutlineBridge, findActiveHeading } from "./editorOutline";
import { lineFlashField } from "./livePreviewHelpers";
import { extractHeadings } from "../../notes/outlineModel";

const views: EditorView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); });

function mount(doc: string) {
    const bridge = createEditorOutlineBridge();
    const view = new EditorView({
        parent: document.body,
        state: EditorState.create({ doc, extensions: [bridge.extension, lineFlashField] }),
    });
    views.push(view);
    return { view, bridge };
}

describe("editor outline bridge", () => {
    it("uses current document positions immediately after typing", () => {
        const { view, bridge } = mount("# First\n\n## Target\nBody");
        const oldHeading = bridge.getSnapshot().headings[1];
        view.dispatch({ changes: { from: 0, insert: "Introduction\n\n" } });
        const heading = bridge.getSnapshot().headings[1];
        expect(heading.anchor).toBe(view.state.doc.toString().indexOf("## Target"));
        bridge.select(heading);
        expect(view.state.selection.main.from).toBe(heading.anchor);
        expect(view.state.selection.main.to).toBe(heading.head);
        expect(view.state.field(lineFlashField).size).toBe(1);
        bridge.select(oldHeading);
        expect(view.state.selection.main.from).toBe(heading.anchor);
    });

    it("targets only its editor even when the same document is open twice", () => {
        const first = mount("# First\n\n## Last");
        const second = mount("# First\n\n## Last");
        second.bridge.select(second.bridge.getSnapshot().headings[1]);
        expect(second.view.state.selection.main.from).toBe(9);
        expect(first.view.state.selection.main.from).toBe(0);
    });

    it("refreshes after state replacement and clears destinations on teardown", () => {
        const { view, bridge } = mount("# Old\n## Target");
        view.setState(EditorState.create({
            doc: "# New\n## Destination", extensions: [bridge.extension, lineFlashField],
        }));
        expect(bridge.getSnapshot().headings.map((heading) => heading.title)).toEqual(["New", "Destination"]);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# External\n## Changed" } });
        expect(bridge.getSnapshot().headings[1].title).toBe("Changed");
        view.destroy();
        views.splice(views.indexOf(view), 1);
        expect(bridge.getSnapshot().headings).toEqual([]);
    });

    it("keeps the current section active after its heading leaves the viewport", () => {
        const headings = extractHeadings("# First\n" + "paragraph\n".repeat(100) + "## Last\nbody");
        expect(findActiveHeading(headings, 500)).toBe(headings[0].id);
        expect(findActiveHeading(headings, headings[1].anchor)).toBe(headings[1].id);
        expect(findActiveHeading([], 0)).toBeNull();
    });
});
