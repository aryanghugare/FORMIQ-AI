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
