import { cadEntityBounds } from "./geometry";
import { displayedDimensionValue } from "./dimension-text";
import type {
  Bounds,
  CadEntity,
  CadModel,
  Measurement,
  Point,
  UnsupportedContent,
} from "./types";

/** Bump when extraction output changes so analyses can re-extract retained originals. */
export const PARSER_VERSION = "dxf-2.3.0";

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
// AutoCAD \M+n multibyte escapes: n selects the code page of the two following bytes.
const MIF_ENCODINGS: Record<string, string> = {
  "1": "shift_jis",
  "2": "big5",
  "3": "euc-kr",
  "5": "gbk",
};
function decodeMif(page: string, hex: string): string | undefined {
  const encoding = MIF_ENCODINGS[page];
  if (!encoding) return;
  try {
    const bytes = Uint8Array.from([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16)]);
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return decoded || undefined;
  } catch {
    return;
  }
}
/** Plain text from TEXT/MTEXT content: special characters decoded, formatting codes removed. */
export const cleanText = (s: string) =>
  s
    // Unicode and multibyte escapes first, so formatting removal cannot consume them.
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\M\+([0-9])([0-9A-Fa-f]{4})/g, (m, page: string, hex: string) => decodeMif(page, hex) ?? m)
    .replace(/%%[cC]/g, "Ø")
    .replace(/%%[dD]/g, "°")
    .replace(/%%[pP]/g, "±")
    .replace(/%%[uUoOkK]/g, "")
    .replace(/%%%/g, "%")
    .replace(/%%(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code)))
    // Escaped literals survive formatting removal.
    .replace(/\\\\/g, "\u0000")
    .replace(/\\\{/g, "\u0001")
    .replace(/\\\}/g, "\u0002")
    .replace(/\\P/g, " ")
    .replace(/\\~/g, " ")
    .replace(/\\[LlOoKkNX]/g, "")
    .replace(/\\S([^;]*);/g, (_, stack: string) => stack.replace(/[\^#]/g, "/"))
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/\u0000/g, "\\")
    .replace(/\u0001/g, "{")
    .replace(/\u0002/g, "}");
const r3 = (value: number) => Math.round(value * 1000) / 1000;
type Transform = (p: Point) => Point;
/** Signed area scale of a 2D transform: negative when it mirrors geometry. */
const determinant = (f: Transform) => {
  const o = f({ x: 0, y: 0 }),
    a = f({ x: 1, y: 0 }),
    b = f({ x: 0, y: 1 });
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
};
/** Unit vectors stay equal-length and perpendicular: circles remain circles. */
const conformal = (f: Transform) => {
  const o = f({ x: 0, y: 0 }),
    a = f({ x: 1, y: 0 }),
    b = f({ x: 0, y: 1 });
  const ax = a.x - o.x, ay = a.y - o.y, bx = b.x - o.x, by = b.y - o.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  return Math.abs(la - lb) <= 1e-9 * Math.max(la, lb) && Math.abs(ax * bx + ay * by) <= 1e-9 * la * lb;
};
const directionOf = (f: Transform, at: Point, degrees: number) => {
  const r = (degrees * Math.PI) / 180,
    o = f(at),
    e = f({ x: at.x + Math.cos(r), y: at.y + Math.sin(r) });
  return (((Math.atan2(e.y - o.y, e.x - o.x) * 180) / Math.PI) % 360 + 360) % 360;
};
/** Rational B-spline point by de Boor's algorithm. */
function splinePoint(degree: number, knots: number[], control: Point[], weights: number[], t: number): Point {
  let k = degree;
  while (k < control.length - 1 && t >= knots[k + 1]) k++;
  const d = Array.from({ length: degree + 1 }, (_, j) => {
    const i = j + k - degree,
      w = weights[i] ?? 1;
    return { x: control[i].x * w, y: control[i].y * w, w };
  });
  for (let r = 1; r <= degree; r++)
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree,
        span = knots[i + degree - r + 1] - knots[i],
        a = span ? (t - knots[i]) / span : 0;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
        w: (1 - a) * d[j - 1].w + a * d[j].w,
      };
    }
  const p = d[degree];
  return { x: p.x / p.w, y: p.y / p.w };
}
const MAX_UNSUPPORTED_RECORDS = 1000;
type HatchPath = { pts: Point[]; bulges: number[]; closed: boolean };
/**
 * Boundary loops of a HATCH, read in file order because its group codes repeat with different
 * meanings in each section. Undefined when the structure is not understood. The fill itself is not read.
 */
function hatchPaths(fields: Pair[]): HatchPath[] | undefined {
  const start = fields.findIndex((f) => f.code === 91);
  if (start < 0) return;
  let i = start + 1;
  const peek = (code: number) => fields[i]?.code === code;
  const read = (code: number) => {
    if (!peek(code)) throw new Error("Unexpected HATCH structure.");
    const value = Number(fields[i++].value);
    if (!Number.isFinite(value)) throw new Error("Invalid numeric DXF group value.");
    return value;
  };
  const readPoint = (x: number, y: number) => ({ x: read(x), y: read(y) });
  // Clockwise edges store mirrored angles; the sweep runs backwards from them.
  const sweepOf = (startDeg: number, endDeg: number, ccw: boolean) => {
    const from = ccw ? startDeg : 360 - startDeg,
      to = ccw ? endDeg : 360 - endDeg;
    const span = ccw ? ((to - from) % 360 + 360) % 360 || 360 : -(((from - to) % 360 + 360) % 360 || 360);
    return { from, span, steps: Math.max(4, Math.ceil((Math.abs(span) / 360) * 96)) };
  };
  try {
    const count = Number(fields[start].value);
    const paths: HatchPath[] = [];
    for (let n = 0; n < count; n++) {
      const flags = read(92);
      if (flags & 2) {
        const hasBulge = read(72) !== 0;
        const closed = read(73) !== 0;
        const total = read(93);
        const pts: Point[] = [];
        const bulges: number[] = [];
        for (let k = 0; k < total; k++) {
          pts.push(readPoint(10, 20));
          bulges.push(hasBulge && peek(42) ? read(42) : 0);
        }
        paths.push({ pts, bulges, closed });
      } else {
        const pts: Point[] = [];
        const append = (p: Point) => {
          const last = pts.at(-1);
          if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) pts.push(p);
        };
        const edges = read(93);
        for (let e = 0; e < edges; e++) {
          const type = read(72);
          if (type === 1) {
            append(readPoint(10, 20));
            append(readPoint(11, 21));
          } else if (type === 2) {
            const c = readPoint(10, 20), radius = read(40);
            const startDeg = read(50), endDeg = read(51);
            const { from, span, steps } = sweepOf(startDeg, endDeg, read(73) !== 0);
            for (let k = 0; k <= steps; k++) {
              const a = ((from + (span * k) / steps) * Math.PI) / 180;
              append({ x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) });
            }
          } else if (type === 3) {
            const c = readPoint(10, 20), major = readPoint(11, 21), ratio = read(40);
            const startDeg = read(50), endDeg = read(51);
            const { from, span, steps } = sweepOf(startDeg, endDeg, read(73) !== 0);
            for (let k = 0; k <= steps; k++) {
              const a = ((from + (span * k) / steps) * Math.PI) / 180;
              append({
                x: c.x + major.x * Math.cos(a) - major.y * ratio * Math.sin(a),
                y: c.y + major.y * Math.cos(a) + major.x * ratio * Math.sin(a),
              });
            }
          } else if (type === 4) {
            const degree = read(94);
            read(73);
            read(74);
            const knotCount = read(95), controlCount = read(96);
            const knots: number[] = [], control: Point[] = [], weights: number[] = [];
            for (let k = 0; k < knotCount; k++) knots.push(read(40));
            for (let k = 0; k < controlCount; k++) {
              control.push(readPoint(10, 20));
              if (peek(42)) weights.push(read(42));
            }
            const fit: Point[] = [];
            // Group 97 here counts fit points; after the last edge it counts source objects instead.
            if (peek(97) && (fields[i + 1]?.code === 11 || fields[i + 1]?.code === 12)) {
              const fitCount = read(97);
              for (let k = 0; k < fitCount; k++) fit.push(readPoint(11, 21));
              if (peek(12)) readPoint(12, 22);
              if (peek(13)) readPoint(13, 23);
            }
            const lo = knots[degree], hi = knots[controlCount];
            if (degree >= 1 && controlCount > degree && knotCount === controlCount + degree + 1 && hi > lo) {
              const steps = Math.min(2000, Math.max(16, (controlCount - degree) * 16));
              for (let k = 0; k <= steps; k++)
                append(splinePoint(degree, knots, control, weights.length === controlCount ? weights : [], lo + ((hi - lo) * k) / steps));
            } else if (fit.length > 1) fit.forEach(append);
            else throw new Error("Unreadable HATCH spline.");
          } else throw new Error("Unknown HATCH edge type.");
        }
        paths.push({ pts, bulges: pts.map(() => 0), closed: true });
      }
      const sources = peek(97) ? read(97) : 0;
      for (let k = 0; k < sources && peek(330); k++) i++;
    }
    return paths;
  } catch {
    return;
  }
}

/** Focused ASCII DXF parser. Coordinates and measurements are normalized to millimetres. */
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
  const unsupportedTypes = new Set<string>();
  const unsupported: UnsupportedContent[] = [];
  const skippedCounts: Record<string, number> = {};
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
  const root: Transform = (p) => ({ x: p.x * scale, y: p.y * scale });
  let flattened = 0;
  /** Local polyline vertices with bulged segments sampled, for transforms that do not keep arcs circular. */
  const tessellate = (pts: Point[], bulges: number[], closed: boolean) => {
    const result: Point[] = [];
    const count = closed && pts.length > 2 ? pts.length : pts.length - 1;
    if (pts.length) result.push(pts[0]);
    for (let i = 0; i < count; i++) {
      const a = pts[i],
        b = pts[(i + 1) % pts.length],
        bulge = bulges[i] ?? 0;
      const chord = distance(a, b);
      if (bulge && chord > 0) {
        const theta = 4 * Math.atan(bulge),
          nx = -(b.y - a.y) / chord,
          ny = (b.x - a.x) / chord,
          offset = (chord / 2) * ((1 / bulge - bulge) / 2),
          c = { x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset },
          radius = distance(c, a),
          start = Math.atan2(a.y - c.y, a.x - c.x),
          steps = Math.max(2, Math.ceil((Math.abs(theta) / (2 * Math.PI)) * 96));
        for (let k = 1; k < steps; k++) {
          const angle = start + (theta * k) / steps;
          result.push({ x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) });
        }
      }
      if (i + 1 < pts.length) result.push(b);
    }
    return result;
  };
  // Records skipped content with its location so reviewers can see what was not compared.
  const skip = (
    r: RecordEntity,
    layer: string,
    reason: string,
    transform: Transform,
  ) => {
    skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
    if (unsupported.length >= MAX_UNSUPPORTED_RECORDS) return;
    const xs: number[] = [],
      ys: number[] = [];
    let pendingX: number | undefined;
    for (const f of r.fields) {
      if (f.code >= 10 && f.code <= 18) pendingX = Number(f.value);
      else if (f.code >= 20 && f.code <= 28 && pendingX !== undefined) {
        const q = transform({ x: pendingX, y: Number(f.value) });
        if (Number.isFinite(q.x) && Number.isFinite(q.y)) {
          xs.push(q.x);
          ys.push(q.y);
        }
        pendingX = undefined;
      }
    }
    // HATCH group 10/20 begins with an elevation point; boundary vertices follow.
    if (r.type === "HATCH" && xs.length > 1) {
      xs.shift();
      ys.shift();
    }
    unsupported.push({
      type: r.type,
      layer,
      reason,
      ...(xs.length
        ? {
            bounds: {
              minX: Math.min(...xs),
              minY: Math.min(...ys),
              maxX: Math.max(...xs),
              maxY: Math.max(...ys),
            },
          }
        : {}),
    });
  };
  const consume = (
    list: RecordEntity[],
    transform: Transform,
    parentLayer = "",
    depth = 0,
    path = "",
    handlePrefix = "",
  ) => {
    if (depth > 12) {
      warnings.add(
        "Nested blocks exceed the supported depth. Some geometry was skipped.",
      );
      skippedCounts["nested block depth"] =
        (skippedCounts["nested block depth"] ?? 0) + 1;
      return;
    }
    // Block transforms are fixed for this list: derive scale, handedness and circularity once.
    const keepsCircles = conformal(transform);
    const linearScale = keepsCircles ? Math.sqrt(Math.abs(determinant(transform))) : Number.NaN;
    const transformMirrors = determinant(transform) < 0;
    const mirrorX: Transform = (p) => transform({ x: -p.x, y: p.y });
    for (let index = 0; index < list.length; index++) {
      const r = list[index];
      if (++processed > 100000)
        throw new Error(
          "Drawing exceeds the 100,000 expanded entity limit. Split the drawing by floor or zone.",
        );
      const layer =
        get(r, 8) === "0" && parentLayer
          ? parentLayer
          : (get(r, 8) ?? parentLayer ?? "0");
      if (num(r, 67) === 1) {
        skippedCounts["paper space"] = (skippedCounts["paper space"] ?? 0) + 1;
        continue; // model space only
      }
      layers.add(layer);
      const rawHandle = get(r, 5);
      const handle = rawHandle ? `${handlePrefix}${rawHandle}` : undefined;
      const id = rawHandle ? `${rawHandle}-${serial++}` : String(serial++);
      const context = {
        ...(handle ? { handle } : {}),
        ...(path ? { block: path } : {}),
      };
      const t = (x = 10, y = 20) => transform(point(r, x, y));
      // Extrusion direction (210/220/230). A plan-parallel normal is supported in either sense:
      // (0,0,-1) is the object coordinate system AutoCAD writes for mirrored entities.
      const ex = num(r, 210),
        ey = num(r, 220),
        ez = num(r, 230, 1),
        normal = Math.hypot(ex, ey, ez);
      const planParallel =
        normal > 0 && Math.abs(ex) / normal < 1e-6 && Math.abs(ey) / normal < 1e-6;
      // LINE and SPLINE coordinates are world coordinates; their normal only orients thickness.
      const worldGeometry = r.type === "LINE" || r.type === "SPLINE";
      if (!planParallel && !worldGeometry) {
        warnings.add(
          "Entities drawn on a tilted plane were skipped. This checker supports 2D plan-parallel drawings.",
        );
        skip(r, layer, "non-planar extrusion", transform);
        continue;
      }
      const flipped = planParallel && ez < 0;
      // Object coordinate system (arbitrary axis algorithm): for normal (0,0,-1), X is reversed.
      const ocs: Transform = flipped ? mirrorX : transform;
      const mirrored = transformMirrors !== flipped;
      const pushPolyline = (pts: Point[], bulges: number[], closed: boolean, entityId = id) => {
        const curved = bulges.some((b) => b !== 0);
        if (curved && !keepsCircles) {
          entities.push({ id: entityId, type: "polyline", layer, points: tessellate(pts, bulges, closed).map((p) => vertex(ocs(p))), closed, ...context });
          return;
        }
        entities.push({
          id: entityId,
          type: "polyline",
          layer,
          points: pts.map((p) => vertex(ocs(p))),
          closed,
          // Mirroring reverses each bulge's turning direction.
          ...(curved ? { bulges: mirrored ? bulges.map((b) => (b ? -b : 0)) : bulges } : {}),
          ...context,
        });
      };
      if ([30, 31, 32, 33, 34, 38].some((code) => num(r, code) !== 0)) flattened++;
      if (r.type === "INSERT") {
        const name = get(r, 2) ?? "";
        const b = blocks.get(name);
        if (!b) {
          warnings.add(
            `Block ${name || "(unnamed)"} could not be resolved (including external references).`,
          );
          skip(r, layer, "unresolved block", transform);
          continue;
        }
        const sx = num(r, 41, 1),
          sy = num(r, 42, 1),
          degrees = num(r, 50),
          angle = (degrees * Math.PI) / 180,
          origin = point(r);
        if (sx === 0 || sy === 0) {
          warnings.add("Blocks inserted with zero scale were skipped.");
          skip(r, layer, "zero block scale", transform);
          continue;
        }
        if (Math.abs(sx - sy) > 0.0001)
          warnings.add(
            "Some blocks are scaled non-uniformly; their arcs were converted to sampled curves and their dimensions use measured reference points.",
          );
        // MINSERT arrays repeat the block in the insert's rotated (unscaled) frame.
        const columns = Math.max(1, Math.trunc(num(r, 70, 1))),
          rows = Math.max(1, Math.trunc(num(r, 71, 1))),
          columnSpacing = num(r, 44),
          rowSpacing = num(r, 45);
        if (columns * rows > 10000) {
          warnings.add("Block arrays with more than 10,000 copies were skipped.");
          skip(r, layer, "oversized block array", transform);
          continue;
        }
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++) {
            const ox = column * columnSpacing,
              oy = row * rowSpacing;
            const base = {
              x: origin.x + ox * Math.cos(angle) - oy * Math.sin(angle),
              y: origin.y + ox * Math.sin(angle) + oy * Math.cos(angle),
            };
            const next: Transform = (p) => {
              const x = (p.x - b.base.x) * sx,
                y = (p.y - b.base.y) * sy;
              return ocs({
                x: base.x + x * Math.cos(angle) - y * Math.sin(angle),
                y: base.y + x * Math.sin(angle) + y * Math.cos(angle),
              });
            };
            const copy = columns * rows > 1 ? `[${row},${column}]` : "";
            consume(
              b.records,
              next,
              layer,
              depth + 1,
              path ? `${path}>${name}${copy}` : `${name}${copy}`,
              handle ? `${handle}${copy}>` : handlePrefix,
            );
          }
        continue;
      }
      if (r.type === "HATCH") {
        const paths = hatchPaths(r.fields)?.filter((path) => path.pts.length > 1);
        if (!paths?.length) {
          warnings.add("Some hatches have boundaries that could not be read; they were excluded.");
          skip(r, layer, "unreadable hatch boundary", transform);
          continue;
        }
        warnings.add("Hatch boundaries are compared as outlines; fill patterns and colours are not compared.");
        paths.forEach((path, n) => pushPolyline(path.pts, path.bulges, path.closed, `${id}-b${n}`));
        continue;
      }
      if (r.type === "LINE")
        entities.push({
          id,
          type: "line",
          layer,
          points: [t(), t(11, 21)],
          ...context,
        });
      else if (r.type === "LWPOLYLINE") {
        const pts: Point[] = [];
        const bulges: number[] = [];
        let px = 0;
        for (const f of r.fields) {
          if (f.code === 10) px = Number(f.value);
          if (f.code === 20) {
            pts.push({ x: px, y: Number(f.value) });
            bulges.push(0);
          }
          if (f.code === 42 && bulges.length) {
            const bulge = Number(f.value);
            if (!Number.isFinite(bulge))
              throw new Error("Invalid numeric DXF group value.");
            bulges[bulges.length - 1] = bulge;
          }
        }
        pushPolyline(pts, bulges, !!(num(r, 70) & 1));
      } else if (r.type === "POLYLINE") {
        if (num(r, 70) & (8 | 16 | 64)) {
          warnings.add("3D polylines and meshes are not supported.");
          skip(r, layer, "3D polyline or mesh", transform);
          while (list[index + 1]?.type === "VERTEX") index++;
          continue;
        }
        const pts: Point[] = [];
        const bulges: number[] = [];
        while (list[index + 1]?.type === "VERTEX") {
          const v = list[++index];
          pts.push(point(v));
          bulges.push(num(v, 42));
        }
        pushPolyline(pts, bulges, !!(num(r, 70) & 1));
      } else if (r.type === "CIRCLE" || r.type === "ARC") {
        const localRadius = num(r, 40);
        const localCenter = point(r);
        if (localRadius <= 0 || !Number.isFinite(localRadius))
          throw new Error("Drawing contains an invalid circle or arc radius.");
        if (!keepsCircles) {
          // A non-uniform block scale turns the curve into an ellipse: keep its true shape as samples.
          const start = r.type === "CIRCLE" ? 0 : num(r, 50);
          const sweep = r.type === "CIRCLE" ? 360 : ((num(r, 51) - start) % 360 + 360) % 360 || 360;
          const steps = Math.max(8, Math.ceil((sweep / 360) * 96));
          const samples: Point[] = [];
          for (let k = 0; k <= (r.type === "CIRCLE" ? steps - 1 : steps); k++) {
            const a = ((start + (sweep * k) / steps) * Math.PI) / 180;
            samples.push({ x: localCenter.x + localRadius * Math.cos(a), y: localCenter.y + localRadius * Math.sin(a) });
          }
          pushPolyline(samples, [], r.type === "CIRCLE");
          continue;
        }
        const radius = localRadius * linearScale;
        if (radius <= 0 || !Number.isFinite(radius))
          throw new Error("Drawing contains an invalid circle or arc radius.");
        const center = ocs(localCenter);
        const transformedAngle = (code: number) => {
          const angle = (num(r, code) * Math.PI) / 180;
          const edge = ocs({
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
        // Mirroring reverses the arc's direction, so the counterclockwise start and end swap.
        const startAngle = transformedAngle(mirrored ? 51 : 50),
          endAngle = transformedAngle(mirrored ? 50 : 51);
        entities.push({
          id,
          type: r.type === "CIRCLE" ? "circle" : "arc",
          layer,
          points: [center],
          radius,
          startAngle: r.type === "CIRCLE" ? 0 : startAngle,
          endAngle: r.type === "CIRCLE" ? 0 : endAngle,
          ...context,
        });
      } else if (r.type === "ELLIPSE") {
        // Center and major axis are world coordinates; the minor axis follows the extrusion normal.
        const c = point(r),
          major = point(r, 11, 21),
          ratio = num(r, 40, 1);
        if (!(Math.hypot(major.x, major.y) > 0) || !(ratio > 0) || ratio > 1 + 1e-9) {
          warnings.add("An ellipse with an invalid axis or ratio was excluded.");
          skip(r, layer, "invalid ellipse", transform);
          continue;
        }
        const sense = flipped ? -1 : 1;
        const minor = { x: -major.y * ratio * sense, y: major.x * ratio * sense };
        const start = num(r, 41, 0);
        let end = num(r, 42, 2 * Math.PI);
        while (end <= start) end += 2 * Math.PI;
        const sweep = Math.min(end - start, 2 * Math.PI);
        const full = sweep >= 2 * Math.PI - 1e-9;
        const steps = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * 96));
        const samples: Point[] = [];
        for (let k = 0; k <= (full ? steps - 1 : steps); k++) {
          const u = start + (sweep * k) / steps;
          samples.push({
            x: c.x + major.x * Math.cos(u) + minor.x * Math.sin(u),
            y: c.y + major.y * Math.cos(u) + minor.y * Math.sin(u),
          });
        }
        entities.push({
          id,
          type: "polyline",
          layer,
          points: samples.map((p) => vertex(transform(p))),
          closed: full,
          ...context,
        });
      } else if (r.type === "SPLINE") {
        const control: Point[] = [],
          fit: Point[] = [],
          knots: number[] = [],
          weights: number[] = [];
        let cx: number | undefined, fx: number | undefined;
        for (const f of r.fields) {
          const value = Number(f.value);
          if (f.code === 10) cx = value;
          else if (f.code === 20 && cx !== undefined) {
            control.push({ x: cx, y: value });
            cx = undefined;
          } else if (f.code === 11) fx = value;
          else if (f.code === 21 && fx !== undefined) {
            fit.push({ x: fx, y: value });
            fx = undefined;
          } else if (f.code === 40) knots.push(value);
          else if (f.code === 41) weights.push(value);
        }
        if ([...control, ...fit].some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || knots.some((k) => !Number.isFinite(k)))
          throw new Error("Invalid numeric DXF group value.");
        const degree = Math.trunc(num(r, 71, 3));
        const rational = !!(num(r, 70) & 4) && weights.length === control.length && weights.every((w) => w > 0);
        let samples: Point[] = [];
        if (
          degree >= 1 &&
          control.length > degree &&
          knots.length === control.length + degree + 1 &&
          knots.every((k, i) => i === 0 || k >= knots[i - 1])
        ) {
          const lo = knots[degree],
            hi = knots[control.length];
          const steps = Math.min(2000, Math.max(16, (control.length - degree) * 16));
          if (hi > lo)
            for (let k = 0; k <= steps; k++)
              samples.push(splinePoint(degree, knots, control, rational ? weights : [], lo + ((hi - lo) * k) / steps));
        }
        if (!samples.length && fit.length > 1) {
          warnings.add("Some splines were approximated through their fit points; verify curved geometry manually.");
          samples = fit;
        }
        if (samples.length < 2) {
          warnings.add("A spline without valid control points or knots was excluded.");
          skip(r, layer, "invalid spline", transform);
          continue;
        }
        entities.push({
          id,
          type: "polyline",
          layer,
          points: samples.map((p) => vertex(transform(p))),
          ...context,
        });
      } else if (["TEXT", "MTEXT", "ATTRIB"].includes(r.type)) {
        const text = cleanText(
          r.fields
            .filter((p) => p.code === 1 || p.code === 3)
            .map((p) => p.value)
            .join(""),
        );
        const localRotation =
          r.type === "MTEXT" && get(r, 50) === undefined && get(r, 11) !== undefined
            ? (Math.atan2(num(r, 21), num(r, 11)) * 180) / Math.PI
            : num(r, 50);
        // MTEXT positions are world coordinates; TEXT and ATTRIB use the object coordinate system.
        const place: Transform = r.type === "MTEXT" ? transform : ocs;
        const insert = point(r),
          anchor = place(insert),
          localHeight = num(r, 40),
          radians = (localRotation * Math.PI) / 180;
        // Height and baseline direction are measured through the full block transform.
        const height =
          localHeight > 0
            ? distance(anchor, place({ x: insert.x - Math.sin(radians) * localHeight, y: insert.y + Math.cos(radians) * localHeight }))
            : 0;
        entities.push({
          id,
          type: "text",
          layer,
          points: [anchor],
          text,
          ...(height > 0 ? { height: r3(height) } : {}),
          rotation: r3(directionOf(place, insert, localRotation)),
          ...context,
        });
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
            point: anchor,
            layer,
            entityId: id,
            source: "annotation",
            ...(handle ? { handle } : {}),
          });
        }
      } else if (r.type === "DIMENSION") {
        const dimType = num(r, 70) & 7;
        if (![0, 1].includes(dimType)) {
          warnings.add(
            "Angular, radial, diameter, and ordinate dimensions are excluded from linear checks.",
          );
          skip(r, layer, "non-linear dimension", transform);
          continue;
        }
        const endpointsPresent = [13, 23, 14, 24].every(
          (code) => get(r, code) !== undefined,
        );
        if (get(r, 42) === undefined && !endpointsPresent) {
          warnings.add(
            "A linear dimension is missing its measurement and complete endpoints; it was excluded.",
          );
          skip(r, layer, "incomplete dimension", transform);
          continue;
        }
        const p1 = t(13, 23),
          p2 = t(14, 24),
          anchor = get(r, 13) !== undefined ? p1 : t();
        // Measured axis: the rotation (group 50) for rotated dimensions, the reference line for aligned.
        // The rotation is measured in the object coordinate system, which is mirrored for normal (0,0,-1).
        const axisDegrees = flipped ? 180 - num(r, 50) : num(r, 50);
        const axisPoint =
          dimType === 0
            ? transform({
                x: point(r, 13, 23).x + Math.cos((axisDegrees * Math.PI) / 180),
                y: point(r, 13, 23).y + Math.sin((axisDegrees * Math.PI) / 180),
              })
            : p2;
        const direction =
          ((Math.atan2(axisPoint.y - p1.y, axisPoint.x - p1.x) * 180) /
            Math.PI +
            360) %
          180;
        let geometricValue: number | undefined;
        if (endpointsPresent) {
          const radians = (direction * Math.PI) / 180;
          geometricValue =
            dimType === 0
              ? Math.abs(
                  (p2.x - p1.x) * Math.cos(radians) +
                    (p2.y - p1.y) * Math.sin(radians),
                )
              : distance(p1, p2);
        }
        // A stored measurement cannot be rescaled through a non-uniform block scale; use reference points.
        const stored = get(r, 42) !== undefined && keepsCircles;
        const value = stored
          ? num(r, 42) * linearScale
          : (geometricValue ?? Number.NaN);
        const label = cleanText(get(r, 1) ?? "");
        const tag = tagFrom(layer) ?? tagFrom(label);
        // "<>" or an empty label displays the measurement; other numeric text overrides it.
        const displayText =
          label && !label.includes("<>") && /\d/.test(label)
            ? label
            : undefined;
        if (endpointsPresent)
          entities.push({
            id,
            type: "line",
            layer,
            points: [p1, p2],
            role: "dimension",
            ...context,
          });
        if (
          Number.isFinite(value) &&
          value > 0 &&
          (stored || get(r, 13) !== undefined)
        ) {
          if (
            stored &&
            geometricValue !== undefined &&
            Math.abs(geometricValue - value) > Math.max(0.5, value * 0.001)
          )
            warnings.add(
              "Some stored dimension measurements differ from their reference points (non-associative or scaled dimensions). Stored values are compared; verify these dimensions manually.",
            );
          if (displayText) {
            const shown = displayedDimensionValue(displayText, unit?.[1] ?? null);
            if (shown !== undefined && Math.abs(shown - value) > 0.5)
              warnings.add(
                "Some dimensions display override text that differs from the measured value. Comparisons use the measured value; overrides are reported separately.",
              );
          }
          const sorted = endpointsPresent
            ? [p1, p2].sort((a, b) => a.x - b.x || a.y - b.y)
            : [anchor];
          measurements.push({
            tag:
              tag ??
              `DIM@${layer}:${sorted.map((p) => `${r3(p.x)},${r3(p.y)}`).join("|")}:${dimType}:${Math.round(direction * 100) / 100}`,
            kind: tag ? kindFrom(tag, layer) : "Dimension",
            value: r3(value),
            point: anchor,
            layer,
            entityId: id,
            source: "dimension",
            dimType: dimType === 0 ? "rotated" : "aligned",
            axis: Math.round(direction * 100) / 100,
            ...(get(r, 10) !== undefined ? { linePoint: t() } : {}),
            valueSource: stored ? "stored" : "computed",
            ...(endpointsPresent
              ? {
                  defPoints: [p1, p2] as [Point, Point],
                  geometricValue: r3(geometricValue!),
                }
              : {}),
            ...(displayText ? { displayText } : {}),
            ...(handle ? { handle } : {}),
          });
          if (!tag)
            warnings.add(
              "Untagged linear dimensions are matched by their measured reference points and axis after alignment. Verify automatic matches.",
            );
        } else {
          warnings.add(
            "An invalid or zero-length linear dimension was excluded.",
          );
          skip(r, layer, "invalid dimension", transform);
        }
      } else if (!["SEQEND", "VERTEX", "ENDSEC", "EOF"].includes(r.type)) {
        unsupportedTypes.add(r.type);
        skip(r, layer, "unsupported entity", transform);
      }
    }
  };
  consume(records, root);
  if (flattened)
    warnings.add(
      `${flattened} entities had non-zero elevation or Z coordinates; they were projected onto the plan (X/Y) for comparison.`,
    );
  if (unsupportedTypes.size)
    warnings.add(
      `Unsupported entities: ${Array.from(unsupportedTypes).join(", ")}. They are excluded from the viewer and checks.`,
    );
  if (skippedCounts["paper space"])
    warnings.add(
      `${skippedCounts["paper space"]} paper-space entities (layouts, title blocks or viewports) were not compared. Only model space is analyzed.`,
    );
  if (!measurements.length)
    warnings.add(
      "No readable linear dimensions were found. Revision analysis will compare extracted geometry instead; plain text numbers are not treated as measurements.",
    );
  let pointCount = 0;
  const bounds: Bounds = {
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
    const curveBounds = cadEntityBounds(entity);
    if (curveBounds) {
      extend({ x: curveBounds.minX, y: curveBounds.minY });
      extend({ x: curveBounds.maxX, y: curveBounds.maxY });
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
    parserVersion: PARSER_VERSION,
    unsupported,
    skippedCounts,
  };
}
