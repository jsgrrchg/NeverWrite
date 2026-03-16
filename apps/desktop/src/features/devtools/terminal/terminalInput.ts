export interface TerminalKeyInput {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

export function translateTerminalKeyEvent(event: TerminalKeyInput) {
    if (event.metaKey) {
        return null;
    }

    const modifierParam = getModifierParam(event);

    if (event.ctrlKey && event.key.length === 1) {
        const control = translateCtrlCharacter(event.key);
        if (control) {
            return control;
        }
    }

    switch (event.key) {
        case "Enter":
            return withAltPrefix(event, "\r");
        case "Backspace":
            return withAltPrefix(event, "\u007f");
        case "Tab":
            return event.shiftKey ? "\u001b[Z" : "\t";
        case "Escape":
            return "\u001b";
        case "ArrowUp":
            return modifierParam === 1
                ? "\u001b[A"
                : `\u001b[1;${modifierParam}A`;
        case "ArrowDown":
            return modifierParam === 1
                ? "\u001b[B"
                : `\u001b[1;${modifierParam}B`;
        case "ArrowRight":
            return modifierParam === 1
                ? "\u001b[C"
                : `\u001b[1;${modifierParam}C`;
        case "ArrowLeft":
            return modifierParam === 1
                ? "\u001b[D"
                : `\u001b[1;${modifierParam}D`;
        case "Home":
            return modifierParam === 1
                ? "\u001b[H"
                : `\u001b[1;${modifierParam}H`;
        case "End":
            return modifierParam === 1
                ? "\u001b[F"
                : `\u001b[1;${modifierParam}F`;
        case "Insert":
            return modifierParam === 1
                ? "\u001b[2~"
                : `\u001b[2;${modifierParam}~`;
        case "Delete":
            return modifierParam === 1
                ? "\u001b[3~"
                : `\u001b[3;${modifierParam}~`;
        case "PageUp":
            return modifierParam === 1
                ? "\u001b[5~"
                : `\u001b[5;${modifierParam}~`;
        case "PageDown":
            return modifierParam === 1
                ? "\u001b[6~"
                : `\u001b[6;${modifierParam}~`;
        default:
            if (event.altKey && event.key.length === 1) {
                return `${"\u001b"}${event.key}`;
            }
            return !event.altKey && event.key.length === 1 ? event.key : null;
    }
}

function getModifierParam(event: TerminalKeyInput) {
    let modifier = 1;
    if (event.shiftKey) modifier += 1;
    if (event.altKey) modifier += 2;
    if (event.ctrlKey) modifier += 4;
    return modifier;
}

function withAltPrefix(event: TerminalKeyInput, value: string) {
    return event.altKey ? `${"\u001b"}${value}` : value;
}

function translateCtrlCharacter(key: string) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") {
        return String.fromCharCode(upper.charCodeAt(0) - 64);
    }

    switch (key) {
        case " ":
        case "@":
        case "2":
            return "\u0000";
        case "[":
        case "3":
            return "\u001b";
        case "\\":
        case "4":
            return "\u001c";
        case "]":
        case "5":
            return "\u001d";
        case "^":
        case "6":
            return "\u001e";
        case "_":
        case "7":
        case "/":
            return "\u001f";
        case "8":
            return "\u007f";
        default:
            return null;
    }
}
