import { isNoteTab, type Tab } from "../../app/store/editorStore";

export const SEARCH_NOTE_ID = "__search__";
export const SEARCH_TAB_TITLE = "Search";

export function isSearchTab(tab: Tab) {
    return isNoteTab(tab) && tab.noteId === SEARCH_NOTE_ID;
}
