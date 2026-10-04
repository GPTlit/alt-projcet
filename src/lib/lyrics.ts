export interface LrcLine {
  time: number; // in seconds
  text: string;
}

export function parseLrc(lrcText: string): LrcLine[] {
  if (!lrcText || typeof lrcText !== "string") return [];

  const lines = lrcText.split("\n");
  const result: LrcLine[] = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Reset regex state
    timeRegex.lastIndex = 0;
    const matches: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = timeRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1] || "0", 10);
      const seconds = parseInt(match[2] || "0", 10);
      const fractionStr = match[3] || "0";
      const fraction = parseFloat(`0.${fractionStr}`);
      const timeInSeconds = minutes * 60 + seconds + fraction;
      matches.push(timeInSeconds);
    }

    if (matches.length > 0) {
      const text = trimmed.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, "").trim();
      for (const time of matches) {
        result.push({ time, text });
      }
    }
  }

  // Sort chronologically
  return result.sort((a, b) => a.time - b.time);
}

export function findCurrentLrcIndex(lines: LrcLine[], currentTime: number): number {
  if (!lines || lines.length === 0) return -1;

  let low = 0;
  let high = lines.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const line = lines[mid]!;
    if (line.time <= currentTime) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}
