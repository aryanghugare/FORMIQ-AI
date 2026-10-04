import type { Issue, Point } from "./types";

/** Keep markers apart at the current zoom, including older per-entity runs. */
export function findingMarkers(
  issues: Issue[],
  unitsPerPixel: number,
  selectedId?: string,
) {
  const cell = Math.max(unitsPerPixel, 0.000001) * 44;
  const markers: { point: Point; issues: Issue[] }[] = [];
  const buckets = new Map<string, number[]>();
  for (const issue of issues) {
    if (issue.id === selectedId) continue;
    const x = Math.floor(issue.point.x / cell),
      y = Math.floor(issue.point.y / cell);
    let match: number | undefined;
    for (let dx = -1; dx <= 1 && match === undefined; dx++) {
      for (let dy = -1; dy <= 1 && match === undefined; dy++) {
        for (const index of buckets.get(`${x + dx},${y + dy}`) ?? []) {
          const point = markers[index].point;
          if (
            Math.hypot(point.x - issue.point.x, point.y - issue.point.y) < cell
          ) {
            match = index;
            break;
          }
        }
      }
    }
    if (match === undefined) {
      const index = markers.length;
      markers.push({ point: issue.point, issues: [issue] });
      const key = `${x},${y}`;
      buckets.set(key, [...(buckets.get(key) ?? []), index]);
    } else markers[match].issues.push(issue);
  }
  const selected = issues.find((issue) => issue.id === selectedId);
  if (selected) markers.push({ point: selected.point, issues: [selected] });
  return markers;
}
