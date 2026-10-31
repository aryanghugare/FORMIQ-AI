import type { Bounds, Issue, Point } from "./types";

/** A change a reviewer confirmed in the source CAD, located in latest-revision millimetres. */
export interface ExpectedChange {
  id?: string;
  x: number;
  y: number;
  /** Search radius in mm around the point (defaults to the manifest radius). */
  radius?: number;
  /** Optional constraints a finding must also satisfy to count. */
  category?: NonNullable<Issue["category"]>;
  change?: NonNullable<Issue["change"]>;
  rule?: string;
  note?: string;
}
export interface ScoreOptions {
  radius: number;
  /** Finding categories that are advisories, not changes; excluded from precision. Default: quality. */
  ignoreCategories?: string[];
}
export interface CaseScore {
  expected: number;
  found: number;
  findings: number;
  truePositives: number;
  recall: number;
  precision: number;
  missed: ExpectedChange[];
  falsePositives: { number: number; rule: string; title: string; point: Point }[];
  matches: { expected: string; findings: number[] }[];
}

const distanceToBox = (p: Point, b: Bounds) =>
  Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY));

/**
 * Where a finding claims a change, in latest-revision coordinates. Individual change areas are
 * preferred to the overall extent, so a combined summary finding cannot match everything.
 */
export function findingLocations(issue: Issue): Bounds[] {
  const items = issue.evidence?.items?.map((item) => item.bounds).filter(Boolean) ?? [];
  if (items.length) return items;
  const boxes = [issue.evidence?.latestBounds, issue.geometry?.bounds].filter((b): b is Bounds => !!b && Number.isFinite(b.minX));
  return boxes.length ? boxes : [{ minX: issue.point.x, minY: issue.point.y, maxX: issue.point.x, maxY: issue.point.y }];
}

export function covers(issue: Issue, change: ExpectedChange, radius: number) {
  if (change.category && issue.category !== change.category) return false;
  if (change.change && issue.change !== change.change) return false;
  if (change.rule && issue.rule !== change.rule) return false;
  const r = change.radius ?? radius;
  return findingLocations(issue).some((box) => distanceToBox(change, box) <= r);
}

/** Recall: confirmed changes reported by at least one finding. Precision: findings explained by a confirmed change. */
export function scoreFindings(issues: Issue[], expected: ExpectedChange[], options: ScoreOptions): CaseScore {
  const ignored = new Set(options.ignoreCategories ?? ["quality"]);
  const scored = issues.filter((issue) => !ignored.has(issue.category ?? ""));
  const explained = new Set<number>();
  const missed: ExpectedChange[] = [];
  const matches: CaseScore["matches"] = [];
  expected.forEach((change, index) => {
    const hits = scored.filter((issue) => covers(issue, change, options.radius));
    hits.forEach((issue) => explained.add(issue.number));
    if (hits.length) matches.push({ expected: change.id ?? `#${index + 1}`, findings: hits.map((i) => i.number) });
    else missed.push(change);
  });
  const found = expected.length - missed.length;
  return {
    expected: expected.length,
    found,
    findings: scored.length,
    truePositives: explained.size,
    recall: expected.length ? found / expected.length : 1,
    precision: scored.length ? explained.size / scored.length : 1,
    missed,
    falsePositives: scored
      .filter((issue) => !explained.has(issue.number))
      .map((issue) => ({ number: issue.number, rule: issue.rule, title: issue.title, point: issue.point })),
    matches,
  };
}
