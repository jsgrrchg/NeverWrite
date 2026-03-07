import { useEditorStore } from "../../app/store/editorStore";

export function TabBar() {
    const { tabs, activeTabId, switchTab, closeTab } = useEditorStore();

    if (tabs.length === 0) return null;

    return (
        <div
            className="flex overflow-x-auto flex-shrink-0 select-none scrollbar-hidden"
            style={{
                backgroundColor: "var(--bg-secondary)",
                borderBottom: "1px solid var(--border)",
            }}
        >
            {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                    <div
                        key={tab.id}
                        onClick={() => switchTab(tab.id)}
                        className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer flex-shrink-0 border-r"
                        style={{
                            backgroundColor: isActive
                                ? "var(--bg-primary)"
                                : "var(--bg-secondary)",
                            color: isActive
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            borderColor: "var(--border)",
                            borderBottom: isActive
                                ? "2px solid var(--accent)"
                                : "2px solid transparent",
                        }}
                    >
                        {tab.isDirty && (
                            <span
                                className="w-2 h-2 rounded-full flex-shrink-0"
                                style={{ backgroundColor: "var(--accent)" }}
                            />
                        )}
                        <span className="max-w-[160px] truncate">
                            {tab.title}
                        </span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                closeTab(tab.id);
                            }}
                            className="ml-1 flex-shrink-0 opacity-40 hover:opacity-100 leading-none text-base"
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
