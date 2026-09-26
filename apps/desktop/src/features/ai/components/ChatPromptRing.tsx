import { NavigationRail } from "../../../components/navigation/NavigationRail";
import {
    resolveChatPromptRingHeight,
    type ChatPromptRingItem,
} from "./ChatPromptRing.logic";

interface ChatPromptRingProps {
    hasPersistentGutter: boolean;
    hitStripWidth: number;
    items: readonly ChatPromptRingItem[];
    stripMap: Map<string, HTMLSpanElement>;
    onSelect: (item: ChatPromptRingItem) => void;
}

export function ChatPromptRing(props: ChatPromptRingProps) {
    return (
        <NavigationRail
            {...props}
            testId="chat-prompt-ring"
            height={resolveChatPromptRingHeight(props.items.length)}
            getLabel={(item) => `Jump to prompt: ${item?.userText ?? "User message"}`}
            renderPreview={(item) => (
                <>
                    <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium leading-4">
                        {item.userText ?? "User message"}
                    </span>
                    {item.assistantText ? (
                        <span
                            className="mt-1 overflow-hidden text-xs leading-4"
                            style={{
                                color: "var(--text-secondary)",
                                display: "-webkit-box",
                                WebkitBoxOrient: "vertical",
                                WebkitLineClamp: 3,
                            }}
                        >
                            {item.assistantText}
                        </span>
                    ) : null}
                </>
            )}
        />
    );
}
