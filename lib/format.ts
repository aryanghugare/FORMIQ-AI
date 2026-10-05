import type { Issue } from "./types";
// Explicit locale and time zone keep server rendering and browser hydration identical.
export const DISPLAY_TIME_ZONE = "Asia/Kolkata";
const shortDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: DISPLAY_TIME_ZONE,
});
const timestamp = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
});
const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });
export const formatDate = (value: string) => shortDate.format(new Date(value));
export const formatTimestamp = (value: string) =>
  timestamp.format(new Date(value));
export const formatNumber = (value: number) => number.format(value);
const signed = (v: number) => `${v > 0 ? "+" : ""}${v}`;
export function deltaText(issue: Issue) {
  const d = issue.evidence?.delta;
  if (!d) return "";
  return [
    d.value !== undefined && `value ${signed(d.value)} mm`,
    (d.dx !== undefined || d.dy !== undefined) &&
      `shift (${d.dx ?? 0}, ${d.dy ?? 0}) mm`,
    d.rotation && `rotation ${d.rotation}°`,
    d.length !== undefined && `length ${signed(d.length)} mm`,
    d.radius !== undefined && `radius ${signed(d.radius)} mm`,
  ]
    .filter(Boolean)
    .join("; ");
}
