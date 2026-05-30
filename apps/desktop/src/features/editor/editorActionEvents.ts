// Window-level events the editor listens to so decoupled callers (toolbar
// buttons, vim ex-commands) can trigger active-tab actions without holding a
// reference to the live EditorView. Mirrors the existing close-tab event.

export const REQUEST_CLOSE_ACTIVE_TAB_EVENT =
    "neverwrite:editor:request-close-active-tab";

export const REQUEST_SAVE_ACTIVE_TAB_EVENT =
    "neverwrite:editor:request-save-active-tab";
