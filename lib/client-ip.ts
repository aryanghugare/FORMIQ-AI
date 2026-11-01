import { isIP } from "node:net";

/**
 * The client address, only from a source the deployment declares trustworthy. Route handlers cannot
 * see the socket address, and any header a client can set must not be able to choose a rate-limit key.
 *
 * FORMIQ_CLIENT_IP_HEADER: a single header your edge proxy always overwrites (e.g. true-client-ip).
 * FORMIQ_TRUSTED_PROXY_HOPS: number of your own proxies appending to X-Forwarded-For; the entry
 * added by the outermost one is used, because everything to its left is client-supplied.
 * Neither set, or no valid value: undefined, and callers fall back to per-account limits.
 */
export function clientIp(headers: Headers): string | undefined {
  const valid = (value?: string | null) => {
    const ip = value?.trim();
    return ip && isIP(ip) ? ip : undefined;
  };
  const header = process.env.FORMIQ_CLIENT_IP_HEADER?.trim();
  if (header) return valid(headers.get(header));
  const hops = Number(process.env.FORMIQ_TRUSTED_PROXY_HOPS || 0);
  if (!Number.isInteger(hops) || hops < 1) return;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return valid(chain[chain.length - hops]);
}
