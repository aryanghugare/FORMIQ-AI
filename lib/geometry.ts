import type { CadEntity } from "./types";
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
