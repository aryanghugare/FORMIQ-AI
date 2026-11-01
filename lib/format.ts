import type { Issue } from "./types";
// Explicit locale and time zone keep server rendering and browser hydration identical.
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const validZone = (zone?: string) => {
  if (!zone) return;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return;
  }
};
/** Server-side setting (FORMIQ_TIME_ZONE). The browser receives it with the workspace data. */
export const configuredTimeZone = () =>
  validZone(process.env.FORMIQ_TIME_ZONE?.trim()) ?? DEFAULT_TIME_ZONE;
const formatters = (timeZone: string) => ({
  shortDate: new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone,
  }),
  timestamp: new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }),
});
let active: { zone: string; format: ReturnType<typeof formatters> } | undefined;
const current = () => {
  if (!active) {
    const zone = configuredTimeZone();
    active = { zone, format: formatters(zone) };
  }
  return active.format;
};
/** Called with the workspace's zone so server rendering and hydration format identically. */
export function setDisplayTimeZone(zone?: string) {
  const valid = validZone(zone);
  if (valid && valid !== active?.zone)
    active = { zone: valid, format: formatters(valid) };
}
const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });
export const formatDate = (value: string) =>
  current().shortDate.format(new Date(value));
export const formatTimestamp = (value: string) =>
  current().timestamp.format(new Date(value));
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
