import type { NextRequest } from "next/server";

function validOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

export function allowedWriteOrigin(request: NextRequest): boolean {
  const supplied = request.headers.get("origin");
  if (!supplied) return true;
  const origin = validOrigin(supplied);
  if (!origin) return false;
  // Prefer a fixed public URL when a reverse proxy hides the external origin.
  const configured =
    process.env.FORMIQ_APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return origin === validOrigin(configured);
  // Next's URL can contain an internal container hostname. The HTTP Host header
  // retains the browser's destination. Never trust X-Forwarded-Host as an allowlist.
  const host = request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? `${forwardedProtocol}:`
      : request.nextUrl.protocol;
  const expected = host
    ? validOrigin(`${protocol}//${host}`)
    : request.nextUrl.origin;
  return origin === expected;
}
