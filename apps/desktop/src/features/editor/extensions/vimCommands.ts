import { Vim } from "@replit/codemirror-vim";
import {
    REQUEST_CLOSE_ACTIVE_TAB_EVENT,
    REQUEST_SAVE_ACTIVE_TAB_EVENT,
} from "../editorActionEvents";

function requestSave() {
    window.dispatchEvent(new Event(REQUEST_SAVE_ACTIVE_TAB_EVENT));
}

function requestClose() {
    window.dispatchEvent(new Event(REQUEST_CLOSE_ACTIVE_TAB_EVENT));
}

let registered = false;

// Map the familiar vim ex-commands onto NeverWrite's existing save/close
// actions so muscle memory (:w, :q, :wq, :x) works. The active tab's editor
// listens for these window events; closing already saves first, so :wq just
// dispatches the close request.
export function registerVimExCommands() {
    if (registered) return;
    registered = true;

    Vim.defineEx("write", "w", () => {
        requestSave();
    });
    Vim.defineEx("quit", "q", () => {
        requestClose();
    });
    Vim.defineEx("wq", "wq", () => {
        requestClose();
    });
    Vim.defineEx("xit", "x", () => {
        requestClose();
    });
}
