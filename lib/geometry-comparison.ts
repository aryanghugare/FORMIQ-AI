import type { CadEntity, CadModel } from "./types";

const rounded = (value: number) => Math.round(value * 1000) / 1000;
function key(entity: CadEntity): string {
  let points = entity.points.map((point) => [
    rounded(point.x),
    rounded(point.y),
  ]);
  if (
    entity.closed &&
    points.length > 1 &&
    JSON.stringify(points[0]) === JSON.stringify(points.at(-1))
  )
    points = points.slice(0, -1);
  const canonical = (input: number[][]) => {
    if (!entity.closed || input.length < 2) return JSON.stringify(input);
    let first = 0;
    for (let index = 1; index < input.length; index++) {
      if (
        input[index][0] < input[first][0] ||
        (input[index][0] === input[first][0] &&
          input[index][1] < input[first][1])
      )
        first = index;
    }
    return JSON.stringify([...input.slice(first), ...input.slice(0, first)]);
  };
  const forward = canonical(points),
    reverse = canonical([...points].reverse());
  const shape = ["line", "polyline"].includes(entity.type)
    ? forward < reverse
      ? forward
      : reverse
    : forward;
  const sweep =
    entity.type === "arc"
      ? [
          rounded(((entity.startAngle ?? 0) + 360) % 360),
          rounded(((entity.endAngle ?? 0) + 360) % 360),
        ]
      : undefined;
  return JSON.stringify([
    entity.type,
    entity.layer,
    shape,
    entity.radius === undefined ? undefined : rounded(entity.radius),
    sweep,
    entity.text,
    Boolean(entity.closed),
  ]);
}
export function geometryChanges(previous: CadModel, latest: CadModel) {
  const group = (entities: CadEntity[]) => {
    const result = new Map<string, CadEntity[]>();
    for (const entity of entities) {
      const signature = key(entity),
        existing = result.get(signature);
      if (existing) existing.push(entity);
      else result.set(signature, [entity]);
    }
    return result;
  };
  const old = group(previous.entities),
    current = group(latest.entities);
  const changes: { entity: CadEntity; change: "added" | "removed" }[] = [];
  let total = 0;
  for (const signature of new Set([...old.keys(), ...current.keys()])) {
    const before = old.get(signature) ?? [],
      after = current.get(signature) ?? [];
    const unchanged = Math.min(before.length, after.length);
    for (const [entities, change] of [
      [before, "removed"],
      [after, "added"],
    ] as const) {
      total += entities.length - unchanged;
      for (let index = unchanged; index < entities.length; index++)
        changes.push({ entity: entities[index], change });
    }
  }
  return { changes, total };
}

// Review spatial areas instead of creating one issue for every CAD primitive.
// Grouping is only a presentation summary: no entity correspondence is inferred.
export function geometryAreas(previous: CadModel, latest: CadModel) {
  const { changes, total } = geometryChanges(previous, latest);
  const bounds = {
    minX: Math.min(previous.bounds.minX, latest.bounds.minX),
    minY: Math.min(previous.bounds.minY, latest.bounds.minY),
    maxX: Math.max(previous.bounds.maxX, latest.bounds.maxX),
    maxY: Math.max(previous.bounds.maxY, latest.bounds.maxY),
  };
  const cell =
    Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) / 8;
  type Area = {
    layer: string;
    added: number;
    removed: number;
    bounds: CadModel["bounds"];
  };
  const areas = new Map<string, Area>();
  for (const { entity, change } of changes) {
    if (!entity.points.length) continue;
    const box = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    for (const point of entity.points) {
      box.minX = Math.min(box.minX, point.x);
      box.maxX = Math.max(box.maxX, point.x);
      box.minY = Math.min(box.minY, point.y);
      box.maxY = Math.max(box.maxY, point.y);
    }
    if (entity.radius !== undefined) {
      const point = entity.points[0];
      box.minX = point.x - entity.radius;
      box.maxX = point.x + entity.radius;
      box.minY = point.y - entity.radius;
      box.maxY = point.y + entity.radius;
    }
    const x = Math.floor(((box.minX + box.maxX) / 2 - bounds.minX) / cell);
    const y = Math.floor(((box.minY + box.maxY) / 2 - bounds.minY) / cell);
    const key = JSON.stringify([entity.layer, x, y]);
    const area = areas.get(key) ?? {
      layer: entity.layer,
      added: 0,
      removed: 0,
      bounds: { ...box },
    };
    area[change]++;
    area.bounds.minX = Math.min(area.bounds.minX, box.minX);
    area.bounds.maxX = Math.max(area.bounds.maxX, box.maxX);
    area.bounds.minY = Math.min(area.bounds.minY, box.minY);
    area.bounds.maxY = Math.max(area.bounds.maxY, box.maxY);
    areas.set(key, area);
  }
  const result = [...areas.values()].sort(
    (a, b) =>
      b.added + b.removed - a.added - a.removed ||
      a.layer.localeCompare(b.layer) ||
      a.bounds.minX - b.bounds.minX ||
      a.bounds.minY - b.bounds.minY,
  );
  // Bound review work while retaining the counts and extent of every change.
  if (result.length > 200) {
    const overflow = result.splice(199);
    const extent = overflow.reduce(
      (b, a) => ({
        minX: Math.min(b.minX, a.bounds.minX),
        maxX: Math.max(b.maxX, a.bounds.maxX),
        minY: Math.min(b.minY, a.bounds.minY),
        maxY: Math.max(b.maxY, a.bounds.maxY),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );
    result.push({
      layer: "Multiple layers",
      added: overflow.reduce((n, a) => n + a.added, 0),
      removed: overflow.reduce((n, a) => n + a.removed, 0),
      bounds: extent,
    });
  }
  const added = result.reduce((n, area) => n + area.added, 0);
  const removed = result.reduce((n, area) => n + area.removed, 0);
  return { areas: result, total, added, removed, combined: areas.size > 200 };
}
