import { create } from "zustand";

export interface Command {
    id: string;
    label: string;
    shortcut?: string;
    category: string;
    when?: () => boolean;
    execute: () => void;
}

interface CommandStore {
    commands: Map<string, Command>;
    activeModal: "command-palette" | "quick-switcher" | null;
    register: (command: Command) => void;
    unregister: (id: string) => void;
    execute: (id: string) => void;
    search: (query: string) => Command[];
    openCommandPalette: () => void;
    openQuickSwitcher: () => void;
    closeModal: () => void;
}

function fuzzyScore(query: string, text: string): number {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (q.length === 0) return 1;

    let qi = 0;
    let score = 0;
    let consecutive = 0;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            qi++;
            consecutive++;
            score += consecutive;
            if (ti === 0) score += 2;
        } else {
            consecutive = 0;
        }
    }

    return qi === q.length ? score : 0;
}

export const useCommandStore = create<CommandStore>((set, get) => ({
    commands: new Map(),
    activeModal: null,

    register: (command) => {
        set((state) => {
            const next = new Map(state.commands);
            next.set(command.id, command);
            return { commands: next };
        });
    },

    unregister: (id) => {
        set((state) => {
            const next = new Map(state.commands);
            next.delete(id);
            return { commands: next };
        });
    },

    execute: (id) => {
        const cmd = get().commands.get(id);
        if (cmd && (!cmd.when || cmd.when())) {
            cmd.execute();
        }
    },

    search: (query) => {
        const commands = Array.from(get().commands.values());
        const visible = commands.filter((c) => !c.when || c.when());
        if (!query.trim()) return visible;

        return visible
            .map((cmd) => ({
                cmd,
                score: Math.max(
                    fuzzyScore(query, cmd.label),
                    fuzzyScore(query, cmd.category + " " + cmd.label),
                ),
            }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ cmd }) => cmd);
    },

    openCommandPalette: () => set({ activeModal: "command-palette" }),
    openQuickSwitcher: () => set({ activeModal: "quick-switcher" }),
    closeModal: () => set({ activeModal: null }),
}));
