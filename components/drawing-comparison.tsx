"use client";
import { useEffect, useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { Drawing, Issue } from "@/lib/types";
import CadViewer from "./cad-viewer";
/** Load only the two drawings displayed in the canvas, not every uploaded model. */
export default function DrawingComparison({
  current,
  previous,
  issues,
  selected,
  onSelect,
}: {
  current?: Drawing;
  previous?: Drawing;
  issues: Issue[];
  selected?: Issue;
  onSelect: (issue: Issue) => void;
}) {
  const [loaded, setLoaded] = useState<Drawing[]>([]),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const currentId = current?.id,
    previousId = previous?.id;
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoaded([]);
    Promise.all(
      [currentId, previousId]
        .filter((id): id is string => Boolean(id))
        .map(async (id) => {
          const response = await fetch(
            `/api/drawings/${encodeURIComponent(id)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Drawing could not be loaded.");
          return data as Drawing;
        }),
    )
      .then((drawings) => {
        if (!controller.signal.aborted) setLoaded(drawings);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Drawing could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [currentId, previousId, retry]);
  const latest = loaded.find((d) => d.id === currentId),
    old = loaded.find((d) => d.id === previousId);
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
  if (currentId && !latest)
    return (
      <div className="viewer-empty" role="status">
        <LoaderCircle className="spin" size={25} />
        <p>Loading comparison drawings…</p>
      </div>
    );
  return (
    <CadViewer
      current={latest}
      previous={old}
      issues={issues}
      selected={selected}
      onSelect={onSelect}
    />
  );
}
