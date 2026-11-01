import { parseDxf } from "./cad";
import { analyze } from "./analysis";

/**
 * Parsing and comparison are the slow, CPU-bound steps. The route runs them BEFORE opening the
 * database transaction (see app/api/[...path]/route.ts), so a large drawing cannot hold a MongoDB
 * transaction open past its time limit. They still run on the request thread; keep drawings modest.
 *
 * These async wrappers are the single call site for that work, so the boundary stays explicit and a
 * future off-thread implementation (worker pool or external service) can slot in without touching the route.
 */
export const parseInWorker = async (content: string) => parseDxf(content);

export const analyzeInWorker = async (...args: Parameters<typeof analyze>) =>
  analyze(...args);
