import type { CadEntity, CadModel, Measurement, Point } from "./types";

type Pair = { code: number; value: string };
type RecordEntity = { type: string; fields: Pair[] };
const get = (r: RecordEntity, code: number) =>
  r.fields.find((p) => p.code === code)?.value;
const num = (r: RecordEntity, code: number, fallback = 0) => {
  const raw = get(r, code);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error("Invalid numeric DXF group value.");
  return value;
};
const point = (r: RecordEntity, x = 10, y = 20): Point => ({
  x: num(r, x),
  y: num(r, y),
});
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const tagFrom = (text: string) =>
  text
    .toUpperCase()
    .match(/(?:^|[\s_\-])((?:D|W|B|S|C|L)\d{1,4})(?=$|[\s_\-:=])/u)?.[1];
const kindFrom = (tag: string, layer: string) => {
  if (/SLAB/i.test(layer) || tag.startsWith("S")) return "Slab";
  if (/BEAM/i.test(layer) || tag.startsWith("B")) return "Beam";
  if (/WALL/i.test(layer)) return "Wall";
  if (/DOOR/i.test(layer) || tag.startsWith("D")) return "Door";
  if (/WINDOW/i.test(layer) || tag.startsWith("W")) return "Window";
  return "Element";
};
const cleanText = (s: string) =>
  s
    .replace(/\\P/g, " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/%%c/gi, "Ø");

/** Focused ASCII DXF parser. Uses only explicit tag associations; never guesses by proximity. */
export function parseDxf(content: string): CadModel {
  if (content.startsWith("AutoCAD Binary DXF"))
    throw new Error(
      "Binary DXF is not supported. Export an ASCII DXF from AutoCAD.",
    );
  const lines = content
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split("\n");
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (lines.length % 2)
    throw new Error("Invalid DXF: incomplete group-code pair.");
  const pairs: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (!/^\s*\d+\s*$/.test(lines[i]))
      throw new Error("Invalid DXF group code. Upload a valid ASCII DXF.");
    pairs.push({ code: Number(lines[i]), value: lines[i + 1].trim() });
  }
  if (
    !pairs.some((p) => p.code === 0 && p.value === "SECTION") ||
    !pairs.some((p) => p.code === 0 && p.value === "EOF")
  )
    throw new Error("Invalid DXF: missing SECTION or EOF.");
  const warnings = new Set<string>();
  const unitIndex = pairs.findIndex(
    (p) => p.code === 9 && p.value === "$INSUNITS",
  );
  const unitCode = unitIndex >= 0 ? Number(pairs[unitIndex + 1]?.value) : 0;
  const units: Record<number, [string, number]> = {
    1: ["in", 25.4],
    2: ["ft", 304.8],
    4: ["mm", 1],
    5: ["cm", 10],
    6: ["m", 1000],
  };
  const unit = units[unitCode];
  if (!unit)
    warnings.add(
      "Drawing units are missing or unsupported. Set $INSUNITS to mm, cm, m, inches, or feet before dimensional analysis.",
    );
  const scale = unit?.[1] ?? 1;
  const records: RecordEntity[] = [];
  const blocks = new Map<string, { base: Point; records: RecordEntity[] }>();
  let section = "";
  let current: RecordEntity | undefined;
  let block: { base: Point; records: RecordEntity[] } | undefined;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code === 0 && p.value === "SECTION") {
      section = pairs[i + 1]?.value;
      current = undefined;
      continue;
    }
    if (p.code === 0 && p.value === "ENDSEC") {
      section = "";
      current = undefined;
      continue;
    }
    if (section !== "ENTITIES" && section !== "BLOCKS") continue;
    if (p.code === 0) {
      current = { type: p.value, fields: [] };
      if (section === "ENTITIES") records.push(current);
      else if (p.value === "BLOCK") {
        const f: Pair[] = [];
        let j = i + 1;
        while (j < pairs.length && pairs[j].code !== 0) f.push(pairs[j++]);
        const b = { type: "BLOCK", fields: f };
        block = { base: point(b), records: [] };
        blocks.set(get(b, 2) ?? "", block);
      } else if (p.value === "ENDBLK") block = undefined;
      else block?.records.push(current);
    } else current?.fields.push(p);
  }
  const entities: CadEntity[] = [];
  const measurements: Measurement[] = [];
  const layers = new Set<string>();
  const unsupported = new Set<string>();
  let serial = 0,
    processed = 0,
    vertexCount = 0;
  const vertex = (p: Point) => {
    if (++vertexCount > 200000)
      throw new Error(
        "Drawing exceeds the 200,000 vertex limit. Split the drawing by floor or zone.",
      );
    return p;
  };
  type Transform = (p: Point) => Point;
  const root: Transform = (p) => ({ x: p.x * scale, y: p.y * scale });
  const consume = (
    list: RecordEntity[],
    transform: Transform,
    parentLayer = "",
    depth = 0,
    uniformScale = scale,
  ) => {
    if (depth > 12) {
      warnings.add(
        "Nested blocks exceed the supported depth. Some geometry was skipped.",
      );
      return;
    }
    for (let index = 0; index < list.length; index++) {
      const r = list[index];
      if (++processed > 100000)
        throw new Error(
          "Drawing exceeds the 100,000 expanded entity limit. Split the drawing by floor or zone.",
        );
      if (num(r, 67) === 1) continue; // model space only
      const layer =
        get(r, 8) === "0" && parentLayer
          ? parentLayer
          : (get(r, 8) ?? parentLayer ?? "0");
      layers.add(layer);
      const id = get(r, 5) ? `${get(r, 5)}-${serial++}` : String(serial++);
      const t = (x = 10, y = 20) => transform(point(r, x, y));
      if (num(r, 210) !== 0 || num(r, 220) !== 0 || num(r, 230, 1) !== 1) {
        warnings.add(
          "Non-planar extrusion geometry was skipped. This checker supports 2D model-space drawings.",
        );
        continue;
      }
      if ([30, 31, 32, 33, 34, 38].some((code) => num(r, code) !== 0)) {
        warnings.add(
          "Non-zero elevations or Z coordinates were skipped. This checker supports planar 2D drawings.",
        );
        continue;
      }
      if (r.type === "INSERT") {
        const b = blocks.get(get(r, 2) ?? "");
        if (!b) {
          warnings.add(
            `Block ${get(r, 2) ?? "(unnamed)"} could not be resolved (including external references).`,
          );
          continue;
        }
        const sx = num(r, 41, 1),
          sy = num(r, 42, 1),
          angle = (num(r, 50) * Math.PI) / 180,
          origin = point(r);
        if (sx === 0 || sy === 0 || Math.abs(sx - sy) > 0.0001) {
          warnings.add(
            "Non-uniformly scaled blocks were skipped to avoid incorrect dimensions.",
          );
          continue;
        }
        if (num(r, 70, 1) > 1 || num(r, 71, 1) > 1) {
          warnings.add("Array block inserts are not expanded.");
          continue;
        }
        const next: Transform = (p) => {
          const x = (p.x - b.base.x) * sx,
            y = (p.y - b.base.y) * sy;
          return transform({
            x: origin.x + x * Math.cos(angle) - y * Math.sin(angle),
            y: origin.y + x * Math.sin(angle) + y * Math.cos(angle),
          });
        };
        consume(b.records, next, layer, depth + 1, uniformScale * Math.abs(sx));
        continue;
      }
      if (r.type === "LINE")
        entities.push({ id, type: "line", layer, points: [t(), t(11, 21)] });
      else if (r.type === "LWPOLYLINE") {
        const pts: Point[] = [];
        let px = 0;
        for (const f of r.fields) {
          if (f.code === 10) px = Number(f.value);
          if (f.code === 20)
            pts.push(vertex(transform({ x: px, y: Number(f.value) })));
        }
        if (r.fields.some((p) => p.code === 42 && Number(p.value) !== 0))
          warnings.add(
            "Polyline bulges are shown as straight segments; curved geometry requires manual verification.",
          );
        entities.push({
          id,
          type: "polyline",
          layer,
          points: pts,
          closed: !!(num(r, 70) & 1),
        });
      } else if (r.type === "POLYLINE") {
        if (num(r, 70) & (8 | 16 | 64)) {
          warnings.add("3D polylines and meshes are not supported.");
          continue;
        }
        const pts: Point[] = [];
        while (list[index + 1]?.type === "VERTEX")
          pts.push(vertex(transform(point(list[++index]))));
        entities.push({
          id,
          type: "polyline",
          layer,
          points: pts,
          closed: !!(num(r, 70) & 1),
        });
      } else if (r.type === "CIRCLE" || r.type === "ARC") {
        const radius = num(r, 40) * uniformScale;
        if (radius <= 0 || !Number.isFinite(radius))
          throw new Error("Drawing contains an invalid circle or arc radius.");
        const center = t(),
          localCenter = point(r),
          localRadius = num(r, 40);
        const transformedAngle = (code: number) => {
          const angle = (num(r, code) * Math.PI) / 180;
          const edge = transform({
            x: localCenter.x + localRadius * Math.cos(angle),
            y: localCenter.y + localRadius * Math.sin(angle),
          });
          return (
            ((Math.atan2(edge.y - center.y, edge.x - center.x) * 180) /
              Math.PI +
              360) %
            360
          );
        };
        entities.push({
          id,
          type: r.type === "CIRCLE" ? "circle" : "arc",
          layer,
          points: [center],
          radius,
          startAngle: transformedAngle(50),
          endAngle: transformedAngle(51),
        });
      } else if (["TEXT", "MTEXT", "ATTRIB"].includes(r.type)) {
        const text = cleanText(
          r.fields
            .filter((p) => p.code === 1 || p.code === 3)
            .map((p) => p.value)
            .join(""),
        );
        entities.push({ id, type: "text", layer, points: [t()], text });
        // Explicit schedule annotation: D14 = 1000 mm. Untyped numbers are not dimensions.
        const match = text
          .toUpperCase()
          .match(
            /\b((?:D|W|B|S|C|L)\d{1,4})\s*[:=]\s*(\d+(?:\.\d+)?)\s*(MM|CM|M|IN|FT)\b/,
          );
        if (match) {
          const factors: Record<string, number> = {
            MM: 1,
            CM: 10,
            M: 1000,
            IN: 25.4,
            FT: 304.8,
          };
          measurements.push({
            tag: match[1],
            kind: kindFrom(match[1], layer),
            value: Number(match[2]) * factors[match[3]],
            point: t(),
            layer,
            entityId: id,
            source: "annotation",
          });
        }
      } else if (r.type === "DIMENSION") {
        const dimType = num(r, 70) & 7;
        if (![0, 1].includes(dimType)) {
          warnings.add(
            "Angular, radial, diameter, and ordinate dimensions are excluded from linear checks.",
          );
          continue;
        }
        const endpointsPresent = [13, 23, 14, 24].every(
          (code) => get(r, code) !== undefined,
        );
        if (get(r, 42) === undefined && !endpointsPresent) {
          warnings.add(
            "A linear dimension is missing its measurement and complete endpoints; it was excluded.",
          );
          continue;
        }
        const p1 = t(13, 23),
          p2 = t(14, 24),
          anchor = get(r, 13) !== undefined ? p1 : t();
        let value =
          get(r, 42) !== undefined
            ? num(r, 42) * uniformScale
            : distance(p1, p2);
        if (get(r, 42) === undefined && dimType === 0) {
          const angle = (num(r, 50) * Math.PI) / 180;
          const a = point(r, 13, 23),
            b = point(r, 14, 24);
          value =
            Math.abs(
              (b.x - a.x) * Math.cos(angle) + (b.y - a.y) * Math.sin(angle),
            ) * uniformScale;
        }
        const label = cleanText(get(r, 1) ?? "");
        const tag = tagFrom(layer) ?? tagFrom(label);
        if (endpointsPresent)
          entities.push({ id, type: "line", layer, points: [p1, p2] });
        if (
          tag &&
          Number.isFinite(value) &&
          value > 0 &&
          (get(r, 42) !== undefined || get(r, 13) !== undefined)
        ) {
          measurements.push({
            tag,
            kind: kindFrom(tag, layer),
            value: Math.round(value * 1000) / 1000,
            point: anchor,
            layer,
            entityId: id,
            source: "dimension",
          });
        } else
          warnings.add(
            "Some linear dimensions have no stable element tag. Use layers such as DOOR_D14 or dimension text containing D14.",
          );
      } else if (!["SEQEND", "VERTEX", "ENDSEC", "EOF"].includes(r.type))
        unsupported.add(r.type);
    }
  };
  consume(records, root);
  if (unsupported.size)
    warnings.add(
      `Unsupported entities: ${Array.from(unsupported).join(", ")}. They are excluded from the viewer and checks.`,
    );
  if (!measurements.length)
    warnings.add(
      "No explicitly tagged linear measurements were found. Add tagged DIMENSION entities or annotations such as D14 = 1000 mm.",
    );
  let pointCount = 0;
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  const extend = (p: Point) => {
    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      Math.abs(p.x) > 1e12 ||
      Math.abs(p.y) > 1e12
    )
      throw new Error(
        "Drawing contains invalid or excessively large geometry coordinates.",
      );
    pointCount++;
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxY = Math.max(bounds.maxY, p.y);
  };
  for (const entity of entities) {
    for (const p of entity.points) extend(p);
    if (entity.radius !== undefined) {
      const p = entity.points[0];
      extend({ x: p.x - entity.radius, y: p.y - entity.radius });
      extend({ x: p.x + entity.radius, y: p.y + entity.radius });
    }
  }
  for (const measurement of measurements) {
    if (
      !Number.isFinite(measurement.value) ||
      measurement.value <= 0 ||
      measurement.value > 1e12
    )
      throw new Error("Drawing contains an invalid linear measurement.");
    extend(measurement.point);
  }
  return {
    entities,
    measurements,
    layers: [...layers],
    units: unit?.[0] ?? "unknown",
    unitScale: unit?.[1] ?? null,
    warnings: [...warnings],
    bounds: pointCount ? bounds : { minX: 0, minY: 0, maxX: 10000, maxY: 8000 },
    entityCount: processed,
  };
}
