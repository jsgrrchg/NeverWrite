import { useArchiveNoticeStore } from "../chatArchiving";

export function ChatArchiveNotice() {
    const notice = useArchiveNoticeStore(state => state.notice);
    if (!notice) return null;
    return <div role="status" className="fixed bottom-6 right-6 z-[10060] flex items-center gap-3 rounded-lg border p-3 text-xs shadow-lg" style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", borderColor: "var(--border)" }}>
        <span>Chat archived. Any running turn continues.</span>
        <button type="button" onClick={notice.undo}>Undo</button>
        <button type="button" onClick={notice.open}>Open chat</button>
        <button type="button" aria-label="Dismiss archive notice" onClick={() => useArchiveNoticeStore.setState({ notice: null })}>×</button>
    </div>;
}
