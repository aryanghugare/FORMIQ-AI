import type { MemoryCase } from "./types";
// Actual ASCII DXF fixtures, not precomputed findings.
export function demoDxf(revision: "old" | "new" | "formwork") {
  const pairs: (string | number)[] = [
    0,
    "SECTION",
    2,
    "HEADER",
    9,
    "$ACADVER",
    1,
    "AC1015",
    9,
    "$INSUNITS",
    70,
    4,
    0,
    "ENDSEC",
    0,
    "SECTION",
    2,
    "ENTITIES",
  ];
  let handle = 16;
  const line = (
    layer: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) =>
    pairs.push(
      0,
      "LINE",
      5,
      (handle++).toString(16),
      8,
      layer,
      10,
      x1,
      20,
      y1,
      11,
      x2,
      21,
      y2,
    );
  const text = (s: string, x: number, y: number, layer = "ANNOTATIONS") =>
    pairs.push(
      0,
      "TEXT",
      5,
      (handle++).toString(16),
      8,
      layer,
      10,
      x,
      20,
      y,
      40,
      140,
      1,
      s,
    );
  const rect = (layer: string, x: number, y: number, w: number, h: number) => {
    line(layer, x, y, x + w, y);
    line(layer, x + w, y, x + w, y + h);
    line(layer, x + w, y + h, x, y + h);
    line(layer, x, y + h, x, y);
  };
  rect("WALLS", 0, 0, 12000, 8200);
  rect("WALLS", 180, 180, 11640, 7840);
  line("WALLS", 4100, 180, 4100, 3600);
  line("WALLS", 4280, 180, 4280, 3600);
  line("WALLS", 8000, 180, 8000, 4800);
  line("WALLS", 8180, 180, 8180, 4800);
  line("WALLS", 180, 4100, 4800, 4100);
  line("WALLS", 180, 4280, 4800, 4280);
  line("WALLS", 6100, 4100, 11820, 4100);
  line("WALLS", 6100, 4280, 11820, 4280);
  text("LIVING / DINING", 5100, 2200);
  text("BEDROOM 01", 1000, 2100);
  text("BEDROOM 02", 9300, 6300);
  text("KITCHEN", 1200, 6400);
  text("UTILITY", 5200, 6400);
  text("LEVEL 12 - TYPICAL FLOOR", 4200, 9000);
  for (let x = -500; x <= 12500; x += 4000) {
    line("GRID", x, -800, x, 8700);
    text(String(Math.round((x + 500) / 4000) + 1), x, 8800, "GRID");
  }
  const elements = [
    {
      tag: "D14",
      kind: "DOOR",
      x: 4800,
      y: 4100,
      value: revision === "new" ? 1000 : 900,
    },
    {
      tag: "W03",
      kind: "WINDOW",
      x: 1200,
      y: 8000,
      value: revision === "new" ? 1500 : 1200,
    },
    {
      tag: "B02",
      kind: "BEAM",
      x: 8400,
      y: 4300,
      value: revision === "new" ? 500 : 450,
    },
    { tag: "D08", kind: "DOOR", x: 7900, y: 1400, value: 800 },
    { tag: "W12", kind: "WALL", x: 4100, y: 5000, value: 200 },
  ];
  if (revision === "new")
    elements.push({ tag: "D21", kind: "DOOR", x: 6100, y: 4200, value: 900 });
  for (const e of elements) {
    const layer = `${e.kind}_${e.tag}`;
    rect(layer, e.x, e.y, e.value, e.kind === "DOOR" ? 180 : 260);
    text(e.tag, e.x + e.value / 2, e.y - 270, layer);
    pairs.push(
      0,
      "DIMENSION",
      5,
      (handle++).toString(16),
      8,
      layer,
      70,
      32,
      10,
      e.x,
      20,
      e.y - 450,
      13,
      e.x,
      23,
      e.y,
      14,
      e.x + e.value,
      24,
      e.y,
      42,
      e.value,
      1,
      "<>",
    );
    if (e.kind === "DOOR") {
      line("DOOR_SWING", e.x, e.y, e.x, e.y + e.value);
      pairs.push(
        0,
        "ARC",
        8,
        "DOOR_SWING",
        10,
        e.x,
        20,
        e.y,
        40,
        e.value,
        50,
        0,
        51,
        90,
      );
    }
  }
  pairs.push(0, "ENDSEC", 0, "EOF");
  return pairs.join("\n") + "\n";
}
export const demoMemory: MemoryCase[] = [
  {
    id: "memory-opening",
    title: "Opening revision at a wall-panel interface",
    category: "Openings",
    project: "KK-DEMO-018",
    drawing: "FW-42 Rev.03",
    reference: "RFI-017",
    description:
      "An opening width increased by 100 mm after the initial panel layout was issued.",
    resolution:
      "Review the adjoining wall panels and opening configuration. Coordinate dimensional changes before updating the fabrication schedule.",
    tags: ["Door", "Window", "Opening", "D14"],
    approvedBy: "Demo design lead",
    approvedAt: "2026-09-12",
    demo: true,
  },
  {
    id: "memory-beam",
    title: "Beam depth and soffit panel coordination",
    category: "Structure",
    project: "KK-DEMO-024",
    drawing: "FW-B08 Rev.02",
    reference: "RFI-032",
    description:
      "Architectural beam depth differed from the selected formwork soffit arrangement.",
    resolution:
      "Confirm the structural depth with the engineer and update the soffit and adjoining panel details together.",
    tags: ["Beam", "Slab", "B02"],
    approvedBy: "Demo design lead",
    approvedAt: "2026-09-08",
    demo: true,
  },
  {
    id: "memory-release",
    title: "Drawing revision before fabrication release",
    category: "Fabrication",
    project: "KK-DEMO-011",
    drawing: "FW-L10 Rev.04",
    reference: "NCR-008",
    description:
      "A late dimension change affected a fabrication schedule that had already been issued.",
    resolution:
      "Trace the affected drawing and BOM items. Obtain designer approval and coordinate a controlled release.",
    tags: ["BOM", "Revision", "Release"],
    approvedBy: "Demo quality lead",
    approvedAt: "2026-08-28",
    demo: true,
  },
];
