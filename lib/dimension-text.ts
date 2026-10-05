/** Parse a complete numeric dimension override, never digits embedded in a part tag or note. */
export function displayedDimensionValue(text: string | undefined, unitScale: number | null = 1): number | undefined {
  if (!text || text.includes("<>")) return;
  const match = text.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|m|in|ft|\"|')?$/i);
  if (!match) return;
  const factors: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, '"': 25.4, "'": 304.8 };
  const scale = match[2] ? factors[match[2].toLowerCase()] : unitScale;
  if (!scale) return;
  const value = Number(match[1]) * scale;
  return Number.isFinite(value) ? value : undefined;
}
