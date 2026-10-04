import { arcPath } from "./geometry";
import type { CadModel, Drawing, Issue, Project, AnalysisRun } from "./types";
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const csv = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
export function issueCsv(issues: Issue[]) {
  const header = [
    "Issue",
    "Element",
    "Rule",
    "Priority",
    "Status",
    "Previous (mm)",
    "Current (mm)",
    "Formwork (mm)",
    "Description",
    "Impacts",
    "Designer notes",
    "Reviewed by",
    "Reviewed at",
  ];
  return (
    "\uFEFF" +
    [
      header,
      ...issues.map((i) => [
        i.number,
        i.tag,
        i.rule,
        i.severity,
        i.status,
        i.previous,
        i.current,
        i.formwork,
        i.description,
        i.impact.join("; "),
        i.notes,
        i.reviewedBy,
        i.reviewedAt,
      ]),
    ]
      .map((row) => row.map(csv).join(","))
      .join("\r\n")
  );
}
export function cadSvg(model: CadModel, issues: Issue[]) {
  const b = model.bounds,
    pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.06 + 1;
  const vb = `${b.minX - pad} ${-b.maxY - pad} ${b.maxX - b.minX + pad * 2} ${b.maxY - b.minY + pad * 2}`;
  const stroke = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1000) / 1000;
  const geometry = model.entities
    .map((e) => {
      const p = e.points[0];
      if (!p) return "";
      if (e.type === "text")
        return `<text x="${p.x}" y="${-p.y}" font-size="${stroke * 10}" fill="#58616c">${escapeHtml(e.text ?? "")}</text>`;
      if (e.type === "circle")
        return `<circle cx="${p.x}" cy="${-p.y}" r="${e.radius}" fill="none" stroke="#758195" stroke-width="${stroke}"/>`;
      if (e.type === "arc")
        return `<path d="${arcPath(e)}" fill="none" stroke="#758195" stroke-width="${stroke}"/>`;
      const points = e.points.map((p) => `${p.x},${-p.y}`).join(" ");
      return `<${e.closed ? "polygon" : "polyline"} points="${points}" fill="none" stroke="#758195" stroke-width="${stroke}"/>`;
    })
    .join("");
  const marks = issues
    .filter((i) => i.status !== "rejected")
    .map(
      (i) =>
        `<circle cx="${i.point.x}" cy="${-i.point.y}" r="${stroke * 24}" fill="#fff1e6" stroke="#e27634" stroke-width="${stroke * 2}"/><text x="${i.point.x}" y="${-i.point.y + stroke * 6}" text-anchor="middle" font-size="${stroke * 17}" fill="#a44218">${i.number}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" style="width:100%;max-height:550px">${geometry}${marks}</svg>`;
}
export function reportHtml(
  project: Project,
  run: AnalysisRun,
  drawings: Drawing[],
  issues: Issue[],
) {
  const latest = drawings.find((d) => d.id === run.newId);
  return `<!doctype html><html><head><meta charset="utf-8"><title>FORMIQ — ${escapeHtml(project.code)} Review</title><style>body{font:14px Arial,sans-serif;color:#253128;margin:40px;line-height:1.5}h1{font-size:28px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}th{background:#eef3ee}.note{padding:16px;background:#f3f6f0}.high{color:#ad4f2e}.drawing{border:1px solid #ddd;margin:24px 0}button{padding:12px;background:#244f3e;color:white;border:0;border-radius:6px;cursor:pointer}@media print{button{display:none}body{margin:18px}thead{display:table-header-group}tr{break-inside:avoid}.drawing{break-inside:avoid}}</style></head><body><button onclick="window.print()">Print / save as PDF</button><h1>FORMIQ AI · Design review register</h1><h2>${escapeHtml(project.name)}</h2><p>${escapeHtml(project.code)} · ${escapeHtml(project.location)} · Generated ${escapeHtml(new Date().toISOString())}</p><p>Analysis: ${escapeHtml(run.id)} · ${run.checks} checks · Tolerance ${run.tolerance} mm · Designer: ${escapeHtml(run.createdBy)}</p><p>Sources: ${drawings
    .filter((d) => [run.oldId, run.newId, run.formworkId].includes(d.id))
    .map((d) => escapeHtml(d.name + " " + d.revision))
    .join(
      " / ",
    )}</p><div class="note">AI assists. Designers approve. This report does not approve or release any drawing. ${project.demo ? "Illustrative demo drawing set." : ""}</div>${latest?.model ? '<div class="drawing">' + cadSvg(latest.model, issues) + "</div>" : ""}${run.warnings.length ? "<h3>Extraction limitations</h3><ul>" + run.warnings.map((w) => "<li>" + escapeHtml(w) + "</li>").join("") + "</ul>" : ""}<table><thead><tr><th># / Element</th><th>Finding</th><th>Measurements (mm)</th><th>Impact</th><th>Designer review</th></tr></thead><tbody>${issues.map((i) => `<tr><td>${i.number} · ${escapeHtml(i.tag)}<br>${escapeHtml(i.rule)}</td><td class="${i.severity}">${escapeHtml(i.title)}<br>${escapeHtml(i.description)}<br>Priority: ${i.severity}</td><td>Previous: ${i.previous ?? "—"}<br>Latest: ${i.current ?? "—"}<br>Formwork: ${i.formwork ?? "—"}</td><td>${i.impact.map(escapeHtml).join("<br>")}</td><td>${escapeHtml(i.status)}<br>${escapeHtml(i.notes)}<br>${escapeHtml(i.reviewedBy ?? "Pending review")}<br>${escapeHtml(i.reviewedAt ?? "")}</td></tr>`).join("")}</tbody></table></body></html>`;
}
