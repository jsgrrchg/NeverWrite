import { GraphView } from "./GraphView";

interface GraphTabViewProps {
    isVisible?: boolean;
}

export function GraphTabView({ isVisible = true }: GraphTabViewProps) {
    return (
        <div
            className="relative h-full min-h-0 w-full overflow-hidden"
            aria-hidden={!isVisible}
        >
            <GraphView isVisible={isVisible} />
        </div>
    );
}
