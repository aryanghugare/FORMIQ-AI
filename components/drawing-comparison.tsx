"use client";
import { useEffect, useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { AnalysisRun, Drawing, Issue } from "@/lib/types";
import CadViewer from "./cad-viewer";
/** Load the exact models the analysis compared, not every uploaded model. */
export default function DrawingComparison({
  run,
  issues,
  selected,
  onSelect,
}: {
  run: AnalysisRun;
  issues: Issue[];
  selected?: Issue;
  onSelect: (issue: Issue) => void;
}) {
  const [loaded, setLoaded] = useState<{
      legacy: boolean;
      previous: Drawing;
      latest: Drawing;
    }>(),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoaded(undefined);
    fetch(`/api/runs/${encodeURIComponent(run.id)}/models`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Drawings could not be loaded.");
        if (!controller.signal.aborted) setLoaded(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Drawings could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [run.id, retry]);
  if (error)
    return (
      <div className="viewer-empty" role="alert">
        <TriangleAlert size={25} />
        <p>{error}</p>
        <button className="button" onClick={() => setRetry((r) => r + 1)}>
          Retry loading drawings
        </button>
      </div>
    );
  if (!loaded)
    return (
      <div className="viewer-empty" role="status">
        <LoaderCircle className="spin" size={25} />
        <p>Loading comparison drawings…</p>
      </div>
    );
  return (
    <CadViewer
      current={loaded.latest}
      previous={loaded.previous}
      issues={issues}
      selected={selected}
      onSelect={onSelect}
      alignment={run.alignment}
      tolerance={run.config?.geometryTolerance ?? Math.max(run.tolerance, 0.001)}
      legacy={loaded.legacy}
    />
  );
}
