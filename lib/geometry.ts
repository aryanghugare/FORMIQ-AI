import type { CadEntity, Point } from "./types";
/** SVG uses a downward Y axis; CAD uses an upward Y axis. */
export function arcPath(entity: CadEntity): string {
  const center = entity.points[0],
    radius = entity.radius ?? 0;
  if (!center || radius <= 0) return "";
  const start = ((entity.startAngle ?? 0) * Math.PI) / 180,
    end = ((entity.endAngle ?? 90) * Math.PI) / 180;
  const sweep =
    ((entity.endAngle ?? 90) - (entity.startAngle ?? 0) + 360) % 360;
  return `M ${center.x + radius * Math.cos(start)} ${-center.y - radius * Math.sin(start)} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 0 ${center.x + radius * Math.cos(end)} ${-center.y - radius * Math.sin(end)}`;
}
/** Arc defined by a polyline bulge; angles in degrees, counterclockwise from start to end. */
export function bulgeArc(a: Point, b: Point, bulge: number) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    chord = Math.hypot(dx, dy);
  const included = 4 * Math.atan(Math.abs(bulge));
  const radius = chord / (2 * Math.sin(included / 2));
  const offset = ((1 - bulge * bulge) / (4 * bulge)) * chord;
  const center = {
    x: (a.x + b.x) / 2 + (-dy / chord) * offset,
    y: (a.y + b.y) / 2 + (dx / chord) * offset,
  };
  const angle = (p: Point) =>
    ((Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 360) % 360;
  const [from, to] = bulge > 0 ? [a, b] : [b, a];
  return {
    center,
    radius,
    startAngle: angle(from),
    endAngle: angle(to),
    sweep: (included * 180) / Math.PI,
  };
}
/** Polyline SVG path including bulge arcs. */
export function polylinePath(entity: CadEntity): string {
  const pts = entity.points;
  if (!pts.length) return "";
  const parts = [`M ${pts[0].x} ${-pts[0].y}`];
  const count = entity.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length],
      bulge = entity.bulges?.[i] ?? 0;
    if (!bulge || (a.x === b.x && a.y === b.y)) parts.push(`L ${b.x} ${-b.y}`);
    else {
      const { radius } = bulgeArc(a, b, bulge);
      parts.push(
        `A ${radius} ${radius} 0 ${Math.abs(bulge) > 1 ? 1 : 0} ${bulge > 0 ? 0 : 1} ${b.x} ${-b.y}`,
      );
    }
  }
  if (entity.closed) parts.push("Z");
  return parts.join(" ");
}

/** True 2D curve extents shared by extraction and the overlay viewport. */
export function cadEntityBounds(entity: CadEntity) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (p: Point) => {
    bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
  };
  const arc = (center: Point, radius: number, start: number, end: number) => {
    const norm = (a: number) => ((a % 360) + 360) % 360;
    const sweep = norm(end - start) || 360;
    for (const angle of [start, end, ...[0, 90, 180, 270].filter((q) => norm(q - start) <= sweep)]) {
      const r = angle * Math.PI / 180;
      include({ x: center.x + radius * Math.cos(r), y: center.y + radius * Math.sin(r) });
    }
  };
  entity.points.forEach(include);
  if (entity.type === "circle" && entity.points[0]) {
    const p = entity.points[0], r = entity.radius ?? 0;
    include({ x: p.x - r, y: p.y - r }); include({ x: p.x + r, y: p.y + r });
  } else if (entity.type === "arc" && entity.points[0]) {
    arc(entity.points[0], entity.radius ?? 0, entity.startAngle ?? 0, entity.endAngle ?? 0);
  } else if (entity.bulges) {
    const count = entity.closed ? entity.points.length : entity.points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = entity.points[i], b = entity.points[(i + 1) % entity.points.length], bulge = entity.bulges[i];
      if (!bulge || (a.x === b.x && a.y === b.y)) continue;
      const curve = bulgeArc(a, b, bulge);
      arc(curve.center, curve.radius, curve.startAngle, curve.endAngle);
    }
  }
  return Number.isFinite(bounds.minX) ? bounds : undefined;
}
