export interface OffsetLineRange {
  start: number;
  end: number;
}

export function buildLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

export function lineIndexAtOffset(
  lineStarts: number[],
  offset: number,
): number {
  if (lineStarts.length === 0) return 0;

  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return Math.max(0, high);
}

export function insertionLineIndexAtOffset(
  lineStarts: number[],
  offset: number,
): number {
  if (lineStarts.length === 0) {
    return 0;
  }

  let low = 0;
  let high = lineStarts.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] < offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return Math.max(0, Math.min(low, lineStarts.length - 1));
}

export function lineIndexToOffset(
  lineStarts: number[],
  text: string,
  line: number,
): number {
  if (line <= 0) return 0;
  if (line >= lineStarts.length) return text.length;
  return lineStarts[line]!;
}

export function deriveOffsetLineRange(
  lineStarts: number[],
  from: number,
  to: number,
): OffsetLineRange {
  if (from === to) {
    const point = insertionLineIndexAtOffset(lineStarts, from);
    return { start: point, end: point };
  }

  return {
    start: lineIndexAtOffset(lineStarts, from),
    end: lineIndexAtOffset(lineStarts, to - 1) + 1,
  };
}
