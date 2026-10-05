"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Building2,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Download,
  FileCheck2,
  FileText,
  FolderKanban,
  History,
  LayoutDashboard,
  Layers3,
  LoaderCircle,
  LogOut,
  Menu,
  Plus,
  Pencil,
  Trash2,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import type {
  AnalysisRun,
  Drawing,
  Issue,
  MemoryCase,
  Project,
  ReviewStatus,
  WorkspaceData,
} from "@/lib/types";
import DrawingComparison from "./drawing-comparison";
import { useDialogFocus } from "./use-dialog-focus";
import {
  formatDate as date,
  formatTimestamp,
  formatNumber,
  deltaText,
} from "@/lib/format";
type View =
  | "overview"
  | "projects"
  | "drawings"
  | "review"
  | "issues"
  | "memory"
  | "reports"
  | "settings";
type Modal =
  | "upload"
  | "project"
  | "analysis"
  | "memory"
  | "help"
  | "editDrawing"
  | "deleteDrawing"
  | null;
const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "drawings", label: "Drawing library", icon: Layers3 },
  { id: "review", label: "Revision review", icon: ScanLine },
  { id: "issues", label: "Issue register", icon: ClipboardCheck },
  { id: "memory", label: "Design memory", icon: BookOpen },
  { id: "reports", label: "Reports", icon: FileText },
] as const;
const titles: Record<View, string> = {
  overview: "Workspace overview",
  projects: "Your projects",
  drawings: "Drawing library",
  review: "Revision review",
  issues: "Issue register",
  memory: "Kumkang Design Memory",
  reports: "Review reports",
  settings: "Workspace settings",
};
const descriptions: Record<View, string> = {
  overview: "A clearer view of your drawings, revisions, and design risks.",
  projects: "Keep your drawing sets and design reviews in one place.",
  drawings:
    "Controlled drawing sets. Every file, every revision, accounted for.",
  review: "Compare revisions within Architecture or Structure.",
  issues: "Turn detected changes into considered design decisions.",
  memory:
    "Approved knowledge from previous projects, ready for your next review.",
  reports: "Source-linked findings and designer decisions, ready to share.",
  settings: "Set the review parameters for your active project.",
};
const statusLabels: Record<ReviewStatus, string> = {
  open: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
  investigating: "Investigating",
};
const bytes = (n: number) =>
  n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
const dimension = (n?: number) =>
  n === undefined ? "—" : `${formatNumber(n)} mm`;
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(`/api/${path}`, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Request failed.");
  return data as T;
}
const json = (data: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
function Pill({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
function Empty({
  icon: Icon = Layers3,
  title,
  description,
  action,
}: {
  icon?: typeof Layers3;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function ModalFrame({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useDialogFocus<HTMLDivElement>(onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export default function Workspace({
  initialData,
}: { initialData?: WorkspaceData } = {}) {
  const [data, setData] = useState<WorkspaceData | undefined>(initialData),
    [loadError, setLoadError] = useState(""),
    [view, setView] = useState<View>("overview"),
    [projectId, setProjectId] = useState(initialData?.projects[0]?.id ?? ""),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState<Modal>(null),
    [managedDrawing, setManagedDrawing] = useState<Drawing>(),
    [busy, setBusy] = useState(false),
    [signingOut, setSigningOut] = useState(false),
    [toast, setToast] = useState<{ message: string; error?: boolean }>(),
    [selected, setSelected] = useState<Issue>(),
    [notifications, setNotifications] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [runId, setRunId] = useState(""),
    [priority, setPriority] = useState("all"),
    [statusFilter, setStatusFilter] = useState("all");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 6000);
  }, []);
  const refreshSequence = useRef(0),
    mutationPending = useRef(false);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const next = await api<WorkspaceData>("workspace");
    if (sequence !== refreshSequence.current) return next;
    setData(next);
    setProjectId((id) =>
      next.projects.some((p) => p.id === id)
        ? id
        : (next.projects[0]?.id ?? ""),
    );
    return next;
  }, []);
  useEffect(() => {
    if (!initialData) refresh().catch((e) => setLoadError(e.message));
    const sync = () => {
      const v = new URLSearchParams(window.location.search).get("view");
      setView(v && Object.hasOwn(titles, v) ? (v as View) : "overview");
      setSearch("");
      setSelected(undefined);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [refresh]);
  function navigate(next: View) {
    setView(next);
    setSearch("");
    setMobileNav(false);
    setSelected(undefined);
    window.history.pushState(null, "", `/?view=${next}`);
  }
  const project = data?.projects.find((p) => p.id === projectId);
  const drawings = useMemo(
    () => data?.drawings.filter((d) => d.projectId === projectId) ?? [],
    [data, projectId],
  );
  const runs = useMemo(
    () =>
      data?.runs
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? [],
    [data, projectId],
  );
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const issues = useMemo(
    () =>
      data?.issues
        .filter((i) => i.projectId === projectId && i.runId === run?.id)
        .sort((a, b) => a.number - b.number) ?? [],
    [data, projectId, run],
  );
  const open = issues.filter(
      (i) => i.status === "open" || i.status === "investigating",
    ),
    high = open.filter((i) => i.severity === "high");
  const reviewed = issues.filter(
    (i) => i.status === "accepted" || i.status === "rejected",
  );
  const matchingIssues = issues.filter(
    (i) =>
      (priority === "all" || i.severity === priority) &&
      (statusFilter === "all" || i.status === statusFilter) &&
      `${i.title} ${i.tag} ${i.rule} ${i.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const latest =
    drawings.find((d) => d.id === run?.newId) ??
    drawings.find((d) => d.status === "ready");
  const previous = drawings.find((d) => d.id === run?.oldId);
  const activity =
    data?.audit.filter((a) => a.projectId === projectId).slice(0, 5) ?? [];
  const selectedCurrent = selected
    ? issues.find((i) => i.id === selected.id)
    : undefined;
  const closeModal = useCallback(() => setModal(null), []);
  async function mutate<T>(
    action: () => Promise<T>,
    message: string,
    notification?: (value: T) => { message: string; error?: boolean },
  ) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    try {
      const result = await action();
      setModal(null);
      const feedback = notification?.(result) ?? { message };
      try {
        await refresh();
        notify(feedback.message, feedback.error);
      } catch {
        notify(
          `${feedback.message} Reload the page to refresh the workspace.`,
          true,
        );
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Something went wrong.", true);
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }
  async function reviewIssue(
    id: string,
    status: ReviewStatus,
    notes: string,
    expectedVersion: number,
  ) {
    await mutate(async () => {
      await api(
        `issues/${id}`,
        json({ status, notes, expectedVersion }, "PATCH"),
      );
      setSelected((current) => (current?.id === id ? undefined : current));
    }, "Designer decision saved.");
  }
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api("auth/logout", json({}));
      window.location.replace("/login");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Unable to sign out.", true);
      setSigningOut(false);
    }
  }
  if (!data)
    return (
      <main className="boot-screen">
        <div className="brand">
          <img
            className="brand-logo"
            src="/brand-logo.jpeg"
            alt=""
            width={44}
            height={44}
          />
          <span className="brand-name">
            Kumkang Kind<span className="brand-subtitle">Ai'Tech</span>
          </span>
        </div>
        {loadError ? (
          <>
            <p role="alert">{loadError}</p>
            <button
              className="button primary"
              onClick={() => {
                setLoadError("");
                refresh().catch((e) => setLoadError(e.message));
              }}
            >
              Retry loading
            </button>
            <a href="/login">Sign in</a>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={24} />
            <p>Opening your design workspace…</p>
          </>
        )}
      </main>
    );
  const analysisButton = (
    <button
      className="button primary"
      disabled={!project || busy}
      onClick={() => setModal("analysis")}
    >
      <ScanLine size={16} /> Run analysis
    </button>
  );
  const uploadButton = (
    <button
      className="button"
      disabled={!project || busy}
      onClick={() => setModal("upload")}
    >
      <Upload size={16} /> Upload drawings
    </button>
  );
  const table = (list: Issue[], limit?: number) =>
    list.length ? (
      <div className="table-scroll">
        <table className="issue-table">
          <thead>
            <tr>
              <th>Finding / element</th>
              <th>Drawing change</th>
              <th>Priority</th>
              <th>Review status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit ?? list.length).map((i) => (
              <tr key={i.id} onClick={() => setSelected(i)}>
                <td>
                  <div className="finding-name">
                    <span className={`issue-symbol ${i.severity}`}>
                      <TriangleAlert size={14} />
                    </span>
                    <div>
                      <strong>{i.title}</strong>
                      <small>
                        #{String(i.number).padStart(3, "0")} · {i.kind} ·{" "}
                        {i.rule}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="measurement-cell">
                    {i.geometry || i.rule.startsWith("GEO-") ? (
                      <strong>
                        {i.geometry
                          ? `${i.geometry.added} added · ${i.geometry.removed} removed`
                          : i.rule === "GEO-01"
                            ? "Geometry added"
                            : i.rule === "GEO-02"
                              ? "Geometry removed"
                              : "Geometry changed"}
                      </strong>
                    ) : i.previous !== undefined ? (
                      <>
                        {formatNumber(i.previous)} <ArrowRight size={12} />{" "}
                        <strong>
                          {i.current === undefined
                            ? "Removed"
                            : formatNumber(i.current)}
                        </strong>
                      </>
                    ) : (
                      <>
                        <strong>
                          {i.current === undefined
                            ? "—"
                            : formatNumber(i.current)}
                        </strong>
                      </>
                    )}
                    {i.current !== undefined && <span>mm</span>}
                  </div>
                </td>
                <td>
                  <Pill
                    tone={
                      i.severity === "high"
                        ? "orange"
                        : i.severity === "medium"
                          ? "amber"
                          : "gray"
                    }
                  >
                    <span className="status-dot" />
                    {i.severity === "high"
                      ? "High"
                      : i.severity === "medium"
                        ? "Medium"
                        : "Low"}
                  </Pill>
                </td>
                <td>
                  <Pill
                    tone={
                      i.status === "accepted"
                        ? "green"
                        : i.status === "investigating"
                          ? "blue"
                          : "gray"
                    }
                  >
                    {statusLabels[i.status]}
                  </Pill>
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`Review ${i.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(i);
                    }}
                  >
                    <ArrowUpRight size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        icon={ClipboardCheck}
        title={
          issues.length
            ? "No matching findings"
            : "Your review register starts here"
        }
        description={
          issues.length
            ? "Try a different search or filter."
            : "Run an analysis to create source-linked findings for designer review."
        }
        action={!issues.length ? analysisButton : undefined}
      />
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="sidebar-scroll">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("overview");
            }}
          >
            <img
              className="brand-logo"
              src="/brand-logo.jpeg"
              alt=""
              width={44}
              height={44}
            />
            <span className="brand-name">
              Kumkang Kind<span className="brand-subtitle">Ai'Tech</span>
            </span>
          </a>
          <div className="workspace-label">DESIGN ASSURANCE</div>
          <div className="sidebar-divider" />
          <span className="nav-label">WORKSPACE</span>
          <nav>
            {navigation.map((item, index) => (
              <div key={item.id}>
                {index === 5 && (
                  <span className="nav-label secondary-label">
                    KNOWLEDGE & OUTPUT
                  </span>
                )}
                <button
                  className={`nav-item ${view === item.id ? "active" : ""}`}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                  {item.id === "issues" && open.length > 0 && (
                    <span className="nav-count">{open.length}</span>
                  )}
                </button>
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="assistant-card">
              <div className="assistant-icon">
                <Sparkles size={17} />
              </div>
              <strong>AI assists. You approve.</strong>
              <p>Every finding is a starting point for your expertise.</p>
              <button onClick={() => setModal("help")}>
                How Kumkang Kind Ai'Tech works <ArrowUpRight size={13} />
              </button>
            </div>
            <button
              className={`nav-item ${view === "settings" ? "active" : ""}`}
              onClick={() => navigate("settings")}
            >
              <Settings2 size={18} /> Settings
            </button>
          </div>
        </div>
        <div className="profile">
          <div className="avatar">
            {data.user.name
              .split(" ")
              .map((n) => n[0])
              .slice(0, 2)
              .join("")}
          </div>
          <div>
            <strong>{data.user.name}</strong>
            <small>Design workspace</small>
          </div>
          <button
            className="sidebar-signout"
            aria-label="Sign out"
            disabled={signingOut}
            onClick={signOut}
          >
            <LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {navigation.find((n) => n.id === view)?.label ?? "Settings"}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="system-status">
              <span className="status-dot" /> Workspace connected
            </span>
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setModal("help")}
            >
              <CircleHelp size={19} />
            </button>
            <div className="notification-wrap">
              <button
                className="icon-button notification-button"
                aria-label="Recent activity"
                onClick={() => setNotifications(!notifications)}
              >
                <Bell size={19} />
                {activity.length > 0 && <i />}
              </button>
              {notifications && (
                <div className="notification-popover">
                  <strong>Recent workspace activity</strong>
                  {activity.length ? (
                    activity.map((a) => (
                      <div key={a.id}>
                        <span>{a.action}</span>
                        <small>{a.detail}</small>
                      </div>
                    ))
                  ) : (
                    <p>No activity yet.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="tiny-square" /> KUMKANG KIND AI'TECH{" "}
                {project?.demo && (
                  <span className="demo-label">DEMO PROJECT</span>
                )}
              </div>
              <h1>{titles[view]}</h1>
              <p>{descriptions[view]}</p>
            </div>
            <div className="heading-actions">
              {view === "projects" ? (
                <button
                  className="button primary"
                  onClick={() => setModal("project")}
                >
                  <Plus size={16} /> New project
                </button>
              ) : view === "memory" ? (
                <button
                  className="button primary"
                  onClick={() => setModal("memory")}
                >
                  <Plus size={16} /> Add approved reference
                </button>
              ) : view === "reports" ? (
                <button
                  className="button primary"
                  disabled={!run}
                  onClick={() =>
                    window.open(
                      `/api/reports?projectId=${projectId}&runId=${run?.id}&format=html`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <Download size={16} /> Generate report
                </button>
              ) : view === "settings" ? null : (
                <>
                  {uploadButton}
                  {analysisButton}
                </>
              )}
            </div>
          </div>
          {view !== "projects" && view !== "memory" && (
            <div className="project-context">
              <Building2 size={16} />
              <select
                aria-label="Active project"
                disabled={busy}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setRunId("");
                  setSelected(undefined);
                  setSearch("");
                }}
              >
                {data.projects.length ? (
                  data.projects.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name} · {p.code}
                    </option>
                  ))
                ) : (
                  <option value="">Select a project</option>
                )}
              </select>
              <span className="context-divider" />
              <span>
                {project?.location ?? "Create your first project to begin"}
              </span>
              <button
                onClick={() => setModal("project")}
                className="text-button"
              >
                <Plus size={14} /> New project
              </button>
            </div>
          )}
          {view === "overview" && (
            <>
              <div className="stat-grid">
                <Stat
                  label="Drawings in workspace"
                  value={drawings.length}
                  icon={Layers3}
                  detail={`${drawings.filter((d) => d.status === "ready").length} ready for review`}
                  tone="green"
                />
                <Stat
                  label="Findings to review"
                  value={open.length}
                  icon={ScanLine}
                  detail={
                    run
                      ? "From the latest selected analysis"
                      : "Run your first comparison"
                  }
                  tone="orange"
                />
                <Stat
                  label="High-priority findings"
                  value={high.length}
                  icon={TriangleAlert}
                  detail="Potential design impact"
                  tone="amber"
                />
                <Stat
                  label="Designer reviewed"
                  value={`${reviewed.length}/${issues.length}`}
                  icon={ShieldCheck}
                  detail={
                    issues.length
                      ? `${Math.round((reviewed.length / issues.length) * 100)}% of findings reviewed`
                      : "Your decisions will appear here"
                  }
                  tone="green"
                />
              </div>
              <section className="overview-hero">
                <div className="hero-content">
                  <span className="hero-eyebrow">
                    <Sparkles size={14} /> INTELLIGENCE, WITH INTENT
                  </span>
                  <h2>Clarity in every revision.</h2>
                  <p>
                    Find what changed. Understand what it affects.
                    <br />
                    Give your expertise more room to work.
                  </p>
                  <button
                    onClick={() => navigate("review")}
                    className="button hero-button"
                  >
                    Open revision review <ArrowRight size={15} />
                  </button>
                  <span className="hero-footer">
                    <ShieldCheck size={13} /> Designer-led. Source-linked.
                    Always traceable.
                  </span>
                </div>
                <div className="hero-drawing" aria-hidden="true">
                  <div className="hero-grid" />
                  <svg viewBox="0 0 500 260">
                    <g fill="none" stroke="#9bb7a4" strokeWidth="1.6">
                      <path d="M50 40H445V220H50Z M59 49H435V211H59Z M190 49V114 M190 159V211 M200 49V114 M200 159V211 M330 49V211 M340 49V211 M59 130H155 M235 130H435 M59 139H155 M235 139H435" />
                      <path d="M155 130V170 M155 170A40 40 0 0 0 195 130 M330 170H292 M292 170A38 38 0 0 1 330 132" />
                      <path
                        d="M35 30V230 M185 30V230 M335 30V230 M455 30V230 M30 35H465 M30 225H465"
                        strokeDasharray="3 4"
                        opacity=".35"
                      />
                    </g>
                    <g fontSize="8" fontFamily="monospace" fill="#9bb7a4">
                      <text x="85" y="92">
                        BEDROOM 01
                      </text>
                      <text x="227" y="94">
                        LIVING
                      </text>
                      <text x="365" y="180">
                        KITCHEN
                      </text>
                    </g>
                    <rect
                      x="177"
                      y="110"
                      width="35"
                      height="52"
                      rx="4"
                      fill="#d79d69"
                      fillOpacity=".2"
                      stroke="#dfb17d"
                      strokeDasharray="3 3"
                    />
                    <circle cx="199" cy="108" r="10" fill="#ecc695" />
                    <path
                      d="M196 108L198 110L202 106"
                      stroke="#385140"
                      fill="none"
                    />
                    <rect
                      x="214"
                      y="100"
                      width="151"
                      height="49"
                      rx="7"
                      fill="#f5f8f0"
                    />
                    <text
                      x="225"
                      y="119"
                      fontSize="10"
                      fill="#324f3f"
                      fontWeight="600"
                    >
                      Door D14 revised
                    </text>
                    <text x="225" y="136" fontSize="10" fill="#6f776e">
                      900 → 1000 mm
                    </text>
                    <path d="M10 246H480" stroke="#7a9c86" opacity=".4" />
                    <text x="350" y="258" fontSize="8" fill="#9bb7a4">
                      REVISION INTELLIGENCE
                    </text>
                  </svg>
                  <div className="hero-drawing-label">
                    <span className="status-dot" /> MEANINGFUL CHANGES, MADE
                    VISIBLE
                  </div>
                </div>
              </section>
              <div className="section-heading">
                <div>
                  <h2>
                    Review priorities <Pill>{open.length} pending</Pill>
                  </h2>
                  <p>Affected areas that need your attention.</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate("issues")}
                >
                  View all findings <ArrowRight size={14} />
                </button>
              </div>
              <section className="panel">
                {table(
                  open
                    .slice()
                    .sort(
                      (a, b) =>
                        (a.severity === "high" ? 0 : 1) -
                        (b.severity === "high" ? 0 : 1),
                    ),
                  4,
                )}
              </section>
              <div className="overview-bottom">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Controlled drawing set</h2>
                      <p>Your sources for the next review.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("drawings")}
                    >
                      View library <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {drawings.length ? (
                    <div className="mini-drawings">
                      {drawings.slice(0, 3).map((d) => (
                        <div className="mini-drawing" key={d.id}>
                          <div className="file-icon">
                            <FileText size={20} />
                            <span>{d.format}</span>
                          </div>
                          <div>
                            <strong>{d.name}</strong>
                            <small>
                              {d.discipline} · {d.revision} · {bytes(d.size)}
                            </small>
                          </div>
                          <Pill tone={d.status === "ready" ? "green" : "amber"}>
                            {d.status === "ready" ? "Ready" : "Action needed"}
                          </Pill>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="No drawings yet"
                      description="Add two revisions of Architecture or Structure."
                      action={uploadButton}
                    />
                  )}
                </section>
                <section className="panel activity-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Workspace activity</h2>
                      <p>A traceable record of your review.</p>
                    </div>
                    <History size={17} />
                  </div>
                  <div className="timeline">
                    {activity.length ? (
                      activity.slice(0, 3).map((a, i) => (
                        <div className="timeline-item" key={a.id}>
                          <span
                            className={`timeline-dot ${i === 0 ? "active" : ""}`}
                          />
                          <div>
                            <strong>{a.action}</strong>
                            <p>{a.detail}</p>
                            <small>
                              {a.actor} · {date(a.createdAt)}
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted">
                        Your project activity will appear here.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </>
          )}
          {view === "projects" && (
            <>
              <FilterBar
                search={search}
                onSearch={setSearch}
                placeholder="Search projects…"
                count={`${data.projects.length} projects`}
              />
              <div className="project-grid">
                {data.projects
                  .filter((p) =>
                    `${p.name} ${p.code} ${p.location}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((p) => {
                    const ds = data.drawings.filter(
                        (d) => d.projectId === p.id,
                      ),
                      rs = data.runs
                        .filter((r) => r.projectId === p.id)
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
                      pending = data.issues.filter(
                        (i) =>
                          i.runId === rs[0]?.id &&
                          (i.status === "open" || i.status === "investigating"),
                      );
                    return (
                      <button
                        key={p.id}
                        className="project-card"
                        onClick={() => {
                          setProjectId(p.id);
                          setRunId("");
                          navigate("overview");
                        }}
                      >
                        <div className="project-card-top">
                          <div className="project-icon">
                            <Building2 size={24} />
                          </div>
                          <Pill tone={p.demo ? "amber" : "green"}>
                            {p.demo ? "Demo" : "Active"}
                          </Pill>
                        </div>
                        <small className="eyebrow">{p.code}</small>
                        <h2>{p.name}</h2>
                        <p>{p.location}</p>
                        <div className="project-card-stats">
                          <span>
                            <Layers3 size={14} />
                            {ds.length} drawings
                          </span>
                          <span>
                            <ScanLine size={14} />
                            {pending.length} to review
                          </span>
                        </div>
                        <footer>
                          Open workspace <ArrowUpRight size={16} />
                        </footer>
                      </button>
                    );
                  })}
                <button
                  className="new-project-card"
                  onClick={() => setModal("project")}
                >
                  <Plus size={25} />
                  <strong>Start a new project</strong>
                  <span>A controlled space for your drawing reviews.</span>
                </button>
              </div>
            </>
          )}
          {view === "drawings" && (
            <>
              <div className="notice">
                <Layers3 size={18} />
                <div>
                  <strong>DWG & DXF, one review workflow.</strong>
                  <p>
                    DXF is parsed locally.{" "}
                    {data.converterAvailable
                      ? "DWG conversion is configured."
                      : "DWG originals are retained; a converter is required for extraction."}{" "}
                    <button
                      className="inline-link"
                      onClick={() => setModal("help")}
                    >
                      View import guide
                    </button>
                  </p>
                </div>
              </div>
              <FilterBar
                search={search}
                onSearch={setSearch}
                placeholder="Search file name, revision, or discipline…"
                count={`${drawings.length} controlled drawings`}
              />
              <section className="panel">
                {drawings.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Drawing</th>
                          <th>Discipline</th>
                          <th>Revision</th>
                          <th>Extraction</th>
                          <th>Uploaded</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {drawings
                          .filter((d) =>
                            `${d.name} ${d.revision} ${d.discipline}`
                              .toLowerCase()
                              .includes(search.toLowerCase()),
                          )
                          .map((d) => (
                            <tr key={d.id}>
                              <td>
                                <div className="finding-name">
                                  <div className="file-icon">
                                    <FileText size={18} />
                                    <span>{d.format}</span>
                                  </div>
                                  <div>
                                    <strong>{d.name}</strong>
                                    <small>
                                      {bytes(d.size)}
                                      {d.extraction
                                        ? ` · ${d.extraction.entityCount} entities · ${d.extraction.measurementCount} measurements`
                                        : ""}
                                    </small>
                                    {d.error && (
                                      <small className="text-warning">
                                        {d.error}
                                      </small>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="capitalize">{d.discipline}</td>
                              <td>
                                <Pill>{d.revision}</Pill>
                              </td>
                              <td>
                                <Pill
                                  tone={
                                    d.status === "ready"
                                      ? "green"
                                      : d.status === "failed"
                                        ? "orange"
                                        : "amber"
                                  }
                                >
                                  {d.status === "ready"
                                    ? "Ready"
                                    : d.status === "failed"
                                      ? "Processing failed"
                                      : "Needs conversion"}
                                </Pill>
                                {d.extraction?.warnings.length ? (
                                  <details className="drawing-extraction-notes">
                                    <summary>
                                      {d.extraction.warnings.length} extraction
                                      notes
                                    </summary>
                                    {d.extraction.warnings.map(
                                      (warning, index) => (
                                        <p key={index}>{warning}</p>
                                      ),
                                    )}
                                  </details>
                                ) : null}
                              </td>
                              <td>
                                {date(d.uploadedAt)}
                                <small>{d.uploadedBy}</small>
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    className="button small"
                                    disabled={busy}
                                    onClick={() => {
                                      setManagedDrawing(d);
                                      setModal("editDrawing");
                                    }}
                                    aria-label={`Edit ${d.name}`}
                                  >
                                    <Pencil size={14} /> Edit
                                  </button>
                                  <button
                                    className="button small"
                                    disabled={busy}
                                    onClick={() => {
                                      setManagedDrawing(d);
                                      setModal("deleteDrawing");
                                    }}
                                    aria-label={`Delete ${d.name}`}
                                  >
                                    <Trash2 size={14} /> Delete
                                  </button>
                                  {d.format === "DWG" &&
                                    d.status !== "ready" && (
                                      <button
                                        className="button small"
                                        disabled={
                                          busy || !data.converterAvailable
                                        }
                                        onClick={() =>
                                          mutate(
                                            () =>
                                              api(
                                                `drawings/${d.id}/retry`,
                                                json({}),
                                              ),
                                            "DWG processed.",
                                          )
                                        }
                                        title={
                                          data.converterAvailable
                                            ? "Retry DWG conversion"
                                            : "Start the Docker app or install a DWG converter, then refresh"
                                        }
                                      >
                                        Retry
                                      </button>
                                    )}
                                  <a
                                    className="icon-button"
                                    aria-label={`Download ${d.name}`}
                                    href={`/api/drawings/${d.id}/file`}
                                  >
                                    <Download size={16} />
                                  </a>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="Add your first drawing set"
                    description="Upload previous and latest revisions of the same drawing discipline."
                    action={uploadButton}
                  />
                )}
              </section>
            </>
          )}
          {view === "review" && (
            <>
              {run ? (
                <>
                  <div className="analysis-summary">
                    <div>
                      <span className="analysis-check">
                        <CheckCheck size={20} />
                      </span>
                      <div>
                        <strong>Revision analysis complete</strong>
                        <small>
                          {run.checks} checks · {issues.length} findings ·
                          Tolerance {run.tolerance} mm
                        </small>
                      </div>
                    </div>
                    <label className="run-selector">
                      Analysis run
                      <select
                        aria-label="Analysis run"
                        value={run.id}
                        onChange={(e) => {
                          setRunId(e.target.value);
                          setSelected(undefined);
                        }}
                      >
                        {runs.map((r, i) => (
                          <option key={r.id} value={r.id}>
                            {i === 0 ? "Latest · " : ""}
                            {formatTimestamp(r.createdAt)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="review-layout">
                    <section className="panel review-canvas">
                      <div className="panel-heading">
                        <div>
                          <h2>Drawing comparison</h2>
                          <p>
                            {previous?.revision} <ArrowRight size={12} />{" "}
                            {latest?.revision} ·{" "}
                            {latest?.discipline === "structure"
                              ? "Structure"
                              : "Architecture"}
                          </p>
                        </div>
                        <Pill tone="green">2D model space</Pill>
                      </div>
                      <DrawingComparison
                        key={`${projectId}-${run.id}`}
                        run={run}
                        issues={issues}
                        selected={selectedCurrent}
                        onSelect={setSelected}
                      />
                    </section>
                    <section className="panel review-findings">
                      <div className="panel-heading">
                        <h2>
                          Detected findings <Pill>{issues.length}</Pill>
                        </h2>
                      </div>
                      <div className="review-findings-list">
                        {issues.map((i) => (
                          <button
                            key={i.id}
                            className={`review-finding ${selected?.id === i.id ? "selected" : ""}`}
                            onClick={() => setSelected(i)}
                          >
                            <div>
                              <span className={`finding-number ${i.severity}`}>
                                {String(i.number).padStart(2, "0")}
                              </span>
                              <Pill
                                tone={
                                  i.severity === "high" ? "orange" : "amber"
                                }
                              >
                                {i.severity}
                              </Pill>
                            </div>
                            <strong>{i.title}</strong>
                            <p>
                              {i.current !== undefined
                                ? `${dimension(i.previous)} → ${dimension(i.current)}`
                                : i.description}
                            </p>
                            <footer>
                              <span>{statusLabels[i.status]}</span>
                              <ArrowUpRight size={14} />
                            </footer>
                          </button>
                        ))}
                        {!issues.length && (
                          <Empty
                            icon={CheckCheck}
                            title="No discrepancies found"
                            description="No findings within the supported checks. Review extraction notes and verify the drawings before approval."
                          />
                        )}
                      </div>
                    </section>
                  </div>
                  {run.warnings.length > 0 && (
                    <section className="extraction-notes">
                      <h3>
                        <TriangleAlert size={16} /> Extraction notes — designer
                        verification required
                      </h3>
                      {run.warnings.map((w, i) => (
                        <p key={i}>{w}</p>
                      ))}
                    </section>
                  )}
                </>
              ) : (
                <section className="panel">
                  <Empty
                    icon={ScanLine}
                    title="Bring your revisions into focus"
                    description="Select two Architecture revisions or two Structure revisions to compare dimensions and geometry."
                    action={analysisButton}
                  />
                </section>
              )}
              <div className="method-strip">
                {[
                  "Read drawings",
                  "Compare revisions",
                  "Check dimensions",
                  "Trace impact",
                  "Designer validates",
                ].map((s, i) => (
                  <span key={s}>
                    <i>{i + 1}</i>
                    {s}
                    {i < 4 && <ChevronRight size={14} />}
                  </span>
                ))}
              </div>
            </>
          )}
          {view === "issues" && (
            <>
              <div className="issue-overview">
                <div>
                  <span className="issue-symbol high">
                    <TriangleAlert size={18} />
                  </span>
                  <strong>{high.length}</strong>
                  <span>High priority</span>
                </div>
                <div>
                  <span className="issue-symbol medium">
                    <Clock3 size={18} />
                  </span>
                  <strong>{open.length}</strong>
                  <span>Awaiting review</span>
                </div>
                <div>
                  <span className="issue-symbol accepted">
                    <Check size={18} />
                  </span>
                  <strong>{reviewed.length}</strong>
                  <span>Designer reviewed</span>
                </div>
                <button
                  className="text-button"
                  disabled={!run}
                  onClick={() =>
                    window.open(
                      `/api/reports?projectId=${projectId}&runId=${run?.id}&format=csv`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <ArrowDownToLine size={15} /> Export register
                </button>
              </div>
              <div className="filter-bar">
                <div className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Search issues"
                    placeholder="Search findings, elements, or rules…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  aria-label="Priority filter"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="all">All priorities</option>
                  <option value="high">High priority</option>
                  <option value="medium">Medium priority</option>
                  <option value="low">Low priority</option>
                </select>
                <select
                  aria-label="Review status filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  {Object.entries(statusLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <span className="filter-count">
                  {matchingIssues.length} findings
                </span>
              </div>
              <section className="panel">{table(matchingIssues)}</section>
              {runs.length > 1 && (
                <p className="helper-text">
                  Showing the latest selected run. Select an earlier run in
                  Revision review to inspect its register.
                </p>
              )}
            </>
          )}
          {view === "memory" && (
            <>
              <div className="memory-intro">
                <div className="memory-intro-icon">
                  <BookOpen size={26} />
                </div>
                <div>
                  <h2>Good decisions deserve to be remembered.</h2>
                  <p>
                    Search approved details, closed RFIs, and resolved NCRs.
                    Every reference has a source; every reuse needs your
                    verification.
                  </p>
                </div>
                <Pill tone="green">
                  <ShieldCheck size={12} /> Approved references
                </Pill>
              </div>
              <FilterBar
                search={search}
                onSearch={setSearch}
                placeholder="Search conditions, tags, projects, or RFIs…"
                count={`${data.memory.length} references`}
              />
              <div className="memory-grid">
                {data.memory
                  .filter((m) =>
                    `${m.title} ${m.description} ${m.tags.join(" ")} ${m.reference} ${m.project}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((m) => (
                    <MemoryCard key={m.id} memory={m} />
                  ))}
              </div>
              {!data.memory.filter((m) =>
                `${m.title} ${m.description} ${m.tags.join(" ")} ${m.reference} ${m.project}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ).length && (
                <Empty
                  icon={BookOpen}
                  title="No references found"
                  description="Try another condition or add a source-linked approved reference."
                />
              )}
            </>
          )}
          {view === "reports" && (
            <>
              <div className="report-hero">
                <div className="report-icon">
                  <FileCheck2 size={33} />
                </div>
                <div>
                  <span className="eyebrow">CONTROLLED REVIEW OUTPUT</span>
                  <h2>The whole review. In one place.</h2>
                  <p>
                    Drawing sources, marked-up findings, extraction notes, and
                    designer decisions.
                    <br />A clear record for coordination and follow-up.
                  </p>
                </div>
                <div className="report-hero-count">
                  <strong>{runs.length}</strong>
                  <span>analysis {runs.length === 1 ? "run" : "runs"}</span>
                </div>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Available review reports</h2>
                    <p>Generate a report from any saved analysis run.</p>
                  </div>
                  <Pill>HTML / PDF / CSV</Pill>
                </div>
                {runs.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Analysis run</th>
                          <th>Drawing sources</th>
                          <th>Findings</th>
                          <th>Reviewed</th>
                          <th>Export</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r, i) => {
                          const is = data.issues.filter(
                              (x) => x.runId === r.id,
                            ),
                            reviewCount = is.filter(
                              (x) =>
                                x.status === "accepted" ||
                                x.status === "rejected",
                            ).length;
                          return (
                            <tr key={r.id}>
                              <td>
                                <strong>
                                  Revision review {runs.length - i}
                                </strong>
                                <small>
                                  {formatTimestamp(r.createdAt)} · {r.createdBy}
                                </small>
                              </td>
                              <td>
                                {
                                  drawings.find((d) => d.id === r.oldId)
                                    ?.revision
                                }{" "}
                                <ArrowRight size={12} />{" "}
                                {
                                  drawings.find((d) => d.id === r.newId)
                                    ?.revision
                                }
                                <small>
                                  {drawings.find((d) => d.id === r.newId)?.name}
                                </small>
                              </td>
                              <td>
                                <Pill tone="amber">
                                  {r.issueCount} findings
                                </Pill>
                              </td>
                              <td>
                                {reviewCount} / {is.length}
                              </td>
                              <td>
                                <div className="row-actions">
                                  <a
                                    className="button small"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    href={`/api/reports?projectId=${projectId}&runId=${r.id}&format=html`}
                                  >
                                    <FileText size={14} /> Marked-up report
                                  </a>
                                  <a
                                    className="icon-button"
                                    href={`/api/reports?projectId=${projectId}&runId=${r.id}&format=csv`}
                                    aria-label={`Export run ${runs.length - i} CSV`}
                                  >
                                    <ArrowDownToLine size={16} />
                                  </a>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={FileText}
                    title="Your first report is one analysis away"
                    description="Compare a controlled drawing set, review its findings, and generate a source-linked report."
                    action={analysisButton}
                  />
                )}
              </section>
              <div className="notice">
                <ShieldCheck size={18} />
                <div>
                  <strong>
                    Reports document decisions. Designers authorize release.
                  </strong>
                  <p>
                    Open the marked-up report and choose “Print / save as PDF”
                    for a shareable PDF. AI does not approve or release
                    drawings.
                  </p>
                </div>
              </div>
            </>
          )}
          {view === "settings" && project && (
            <SettingsPanel
              key={project.id}
              project={project}
              converterAvailable={data.converterAvailable}
              busy={busy}
              onSave={(tolerance, bomReleased) =>
                mutate(
                  () =>
                    api(
                      `projects/${project.id}`,
                      json({ tolerance, bomReleased }, "PATCH"),
                    ),
                  "Project settings saved. Run analysis again to apply the changes.",
                )
              }
            />
          )}
          {view === "settings" && !project && (
            <Empty
              title="Create a project first"
              description="Review settings are specific to each project."
              action={
                <button
                  className="button primary"
                  onClick={() => setModal("project")}
                >
                  New project
                </button>
              }
            />
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={13} /> AI assists. Designers approve.
            </span>
            <span>
              Kumkang Kind Ai'Tech <span className="footer-dot">·</span> Kumkang
              Kind
            </span>
          </footer>
        </main>
      </div>
      {modal === "project" && (
        <ModalFrame
          title="Create a project"
          subtitle="Start with a controlled space for your drawings and reviews."
          onClose={closeModal}
        >
          <ProjectForm
            busy={busy}
            onSubmit={(input) =>
              mutate(async () => {
                const p = await api<Project>("projects", json(input));
                setProjectId(p.id);
                navigate("drawings");
              }, "Project created. Add your drawing set to begin.")
            }
          />
        </ModalFrame>
      )}
      {modal === "editDrawing" && managedDrawing && (
        <ModalFrame
          title="Edit drawing details"
          subtitle="Update the file name, revision, or drawing discipline."
          onClose={closeModal}
        >
          <DrawingInfoForm
            drawing={managedDrawing}
            busy={busy}
            onSubmit={(input) =>
              mutate(
                () =>
                  api(`drawings/${managedDrawing.id}`, json(input, "PATCH")),
                "Drawing details updated.",
              )
            }
          />
        </ModalFrame>
      )}
      {modal === "deleteDrawing" && managedDrawing && (
        <ModalFrame
          title="Delete drawing?"
          subtitle={managedDrawing.name}
          onClose={closeModal}
        >
          <div className="modal-form">
            <p className="delete-drawing-message">
              This permanently removes the drawing and its stored file. Drawings
              used in an analysis cannot be deleted.
            </p>
            <div className="modal-actions">
              <button className="button" disabled={busy} onClick={closeModal}>
                Cancel
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() =>
                  mutate(
                    () =>
                      api<{ ok: boolean; warning?: string }>(
                        `drawings/${managedDrawing.id}`,
                        {
                          method: "DELETE",
                        },
                      ),
                    "Drawing deleted.",
                    (result) => ({
                      message: result.warning ?? "Drawing deleted.",
                      error: Boolean(result.warning),
                    }),
                  )
                }
              >
                <Trash2 size={16} /> {busy ? "Deleting…" : "Delete drawing"}
              </button>
            </div>
          </div>
        </ModalFrame>
      )}
      {modal === "upload" && project && (
        <ModalFrame
          title="Upload a drawing"
          subtitle={`Add a controlled revision to ${project.name}.`}
          onClose={closeModal}
        >
          <UploadForm
            busy={busy}
            converterAvailable={data.converterAvailable}
            onSubmit={(form) =>
              mutate(
                async () => {
                  form.set("projectId", projectId);
                  const d = await api<Drawing>("drawings", {
                    method: "POST",
                    body: form,
                  });
                  return d;
                },
                "Drawing uploaded and processed.",
                (d) => ({
                  message:
                    d.status === "ready"
                      ? "Drawing uploaded and processed."
                      : (d.error ??
                        "Drawing saved; processing needs attention."),
                  error: d.status !== "ready",
                }),
              )
            }
          />
        </ModalFrame>
      )}
      {modal === "analysis" && project && (
        <ModalFrame
          title="Run revision analysis"
          subtitle="Choose your source drawings. Kumkang Kind Ai'Tech will compare, check, and explain."
          onClose={closeModal}
        >
          <AnalysisForm
            drawings={drawings}
            busy={busy}
            onSubmit={(input) =>
              mutate(async () => {
                const r = await api<{ run: AnalysisRun }>(
                  "analyze",
                  json({ ...input, projectId }),
                );
                setRunId(r.run.id);
                navigate("review");
              }, "Analysis complete. Findings are ready for designer review.")
            }
          />
        </ModalFrame>
      )}
      {modal === "memory" && (
        <ModalFrame
          title="Add an approved reference"
          subtitle="Record a verified previous solution with its controlled source."
          onClose={closeModal}
          wide
        >
          <MemoryForm
            busy={busy}
            onSubmit={(input) =>
              mutate(
                () => api("memory", json(input)),
                "Approved reference added to Design Memory.",
              )
            }
          />
        </ModalFrame>
      )}
      {modal === "help" && (
        <ModalFrame
          title="How Kumkang Kind Ai'Tech works"
          subtitle="Architecture and structural drawing revision review."
          onClose={closeModal}
          wide
        >
          <div className="help-content">
            <h3>1. Upload a controlled drawing set</h3>
            <p>
              Choose previous and latest revisions of the same discipline:
              Architecture or Structure. Originals are retained and available
              for download.
            </p>
            <h3>2. Make dimensions traceable</h3>
            <p>
              For the most reliable element matching, use linear DIMENSION
              entities on tagged layers such as <code>DOOR_D14</code>, or
              dimension text containing <code>D14</code>. Explicit schedule text
              such as <code>D14 = 1000 mm</code> is also supported. Give each
              checked dimension a unique tag. Ordinary untagged linear
              dimensions are also compared by layer, reference point and
              direction. If dimensions are unavailable, geometry additions and
              removals are reported; moved geometry appears as removed and
              added.
            </p>
            <h3>3. Check CAD extraction</h3>
            <p>
              Supported: ASCII DXF, 2D model space, lines, polylines, circles,
              arcs, text, and uniform block inserts. Set drawing units
              explicitly. Angular dimensions, 3D geometry, splines, external
              references require manual review. Automatic dimension matches also
              need verification. Extraction notes appear alongside analysis.
            </p>
            <h3>4. Convert DWG when needed</h3>
            <p>
              {data.converterAvailable
                ? "A converter is configured in this workspace."
                : "No DWG converter is configured yet."}{" "}
              An administrator can set <code>ODA_CONVERTER_PATH</code> to an
              installed ODA File Converter, or <code>DWG_CONVERTER_PATH</code>{" "}
              to a compatible conversion wrapper. Use ASCII DXF exports in the
              meantime.
            </p>
            <h3>5. Validate and report</h3>
            <p>
              Accept a finding, reject it with a reason, or investigate further.
              Accepting a finding confirms it is valid; drawing release still
              requires designer approval. Reports include the source drawings
              and review decisions.
            </p>
            <div className="sample-downloads">
              <strong>Try the presentation’s example</strong>
              <p>Illustrative DXF files for Door D14, W03, and B02:</p>
              <a href="/samples/ARCH-L12-Rev-05.dxf" download>
                Architecture Rev.05 <Download size={13} />
              </a>
              <a href="/samples/ARCH-L12-Rev-06.dxf" download>
                Architecture Rev.06 <Download size={13} />
              </a>
            </div>
          </div>
        </ModalFrame>
      )}
      {selectedCurrent && (
        <IssueDrawer
          issue={selectedCurrent}
          drawings={drawings}
          memory={data.memory}
          onClose={() => setSelected(undefined)}
          onReview={reviewIssue}
          busy={busy}
        />
      )}
      {toast && (
        <div
          role={toast.error ? "alert" : "status"}
          className={`toast ${toast.error ? "error" : ""}`}
        >
          {toast.error ? <TriangleAlert size={18} /> : <CheckCheck size={18} />}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  icon: Icon,
  detail,
  tone,
}: {
  label: string;
  value: number | string;
  icon: typeof Layers3;
  detail: string;
  tone: string;
}) {
  return (
    <section className="stat-card">
      <div>
        <span>{label}</span>
        <div className={`stat-icon ${tone}`}>
          <Icon size={18} />
        </div>
      </div>
      <strong>{value}</strong>
      <small>
        <span className={`status-dot ${tone}`} />
        {detail}
      </small>
    </section>
  );
}
function FilterBar({
  search,
  onSearch,
  placeholder,
  count,
}: {
  search: string;
  onSearch: (s: string) => void;
  placeholder: string;
  count: string;
}) {
  return (
    <div className="filter-bar">
      <div className="search-box">
        <Search size={16} />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <span className="filter-count">{count}</span>
    </div>
  );
}
function ProjectForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: unknown) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSubmit(Object.fromEntries(f));
      }}
      className="modal-form"
    >
      <label>
        Project name
        <input
          name="name"
          required
          maxLength={160}
          placeholder="e.g. The Meridian Residences"
        />
      </label>
      <div className="form-row">
        <label>
          Project code
          <input
            name="code"
            required
            maxLength={160}
            placeholder="KK-2026-015"
          />
        </label>
        <label>
          Location
          <input
            name="location"
            required
            maxLength={160}
            placeholder="City, country"
          />
        </label>
      </div>
      <label>
        Description
        <textarea
          name="description"
          maxLength={2000}
          placeholder="Scope, floor, or design notes…"
          rows={3}
        />
      </label>
      <div className="form-footer">
        <span>Drawing sets stay linked to this project.</span>
        <button className="button primary" disabled={busy}>
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Plus size={15} />
          )}{" "}
          Create project
        </button>
      </div>
    </form>
  );
}
function DrawingInfoForm({
  drawing,
  busy,
  onSubmit,
}: {
  drawing: Drawing;
  busy: boolean;
  onSubmit: (input: Pick<Drawing, "name" | "revision" | "discipline">) => void;
}) {
  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onSubmit({
          name: String(values.get("name")),
          revision: String(values.get("revision")),
          discipline: String(values.get("discipline")) as Drawing["discipline"],
        });
      }}
    >
      <label>
        File name
        <input
          name="name"
          defaultValue={drawing.name}
          required
          maxLength={160}
        />
      </label>
      <div className="form-row">
        <label>
          Drawing discipline
          <select name="discipline" defaultValue={drawing.discipline}>
            <option value="architecture">Architecture</option>
            <option value="structure">Structure</option>
          </select>
        </label>
        <label>
          Revision identifier
          <input
            name="revision"
            defaultValue={drawing.revision}
            required
            maxLength={160}
          />
        </label>
      </div>
      <p className="helper-text">
        Keep the .{drawing.format.toLowerCase()} extension. Drawings used in an
        analysis are preserved; upload a new revision for later changes.
      </p>
      <div className="form-footer">
        <span>Original geometry retained.</span>
        <button className="button primary" disabled={busy}>
          <Check size={16} /> {busy ? "Saving…" : "Save details"}
        </button>
      </div>
    </form>
  );
}
function UploadForm({
  busy,
  onSubmit,
  converterAvailable,
}: {
  busy: boolean;
  onSubmit: (f: FormData) => void;
  converterAvailable: boolean;
}) {
  const [file, setFile] = useState<File>(),
    [dragging, setDragging] = useState(false),
    [error, setError] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  function choose(f?: File) {
    if (!f) return;
    if (!/\.(dwg|dxf)$/i.test(f.name) || f.size > 30 * 1024 * 1024) {
      setError("Choose a DWG or DXF drawing up to 30 MB.");
      return;
    }
    setFile(f);
    setError("");
  }
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) {
          setError("Select a drawing file first.");
          return;
        }
        const f = new FormData(e.currentTarget);
        f.set("file", file);
        onSubmit(f);
      }}
    >
      <div
        className={`upload-zone ${dragging ? "dragging" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Choose CAD drawing"
        onClick={() => ref.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") ref.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        <div className="upload-icon">
          <Upload size={25} />
        </div>
        <strong>{file ? file.name : "Drop your CAD drawing here"}</strong>
        <span>
          {file
            ? `${bytes(file.size)} · Click to choose another`
            : "or click to browse your files"}
        </span>
        <small>DWG or ASCII DXF · Up to 30 MB</small>
      </div>
      <input
        ref={ref}
        className="sr-only"
        type="file"
        accept=".dwg,.dxf"
        aria-label="Drawing file"
        onChange={(e) => choose(e.target.files?.[0])}
      />
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <div className="form-row">
        <label>
          Drawing discipline
          <select name="discipline">
            <option value="architecture">Architecture</option>
            <option value="structure">Structure</option>
          </select>
        </label>
        <label>
          Revision identifier
          <input
            name="revision"
            required
            maxLength={160}
            placeholder="e.g. Rev.06"
          />
        </label>
      </div>
      {file?.name.toLowerCase().endsWith(".dwg") && !converterAvailable && (
        <div className="alert warning">
          Your DWG original will be saved. Configure a converter to enable the
          viewer and analysis, or upload its ASCII DXF export.
        </div>
      )}
      <div className="form-footer">
        <span>Original retained. Revision traced.</span>
        <button className="button primary" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Upload size={16} />
          )}{" "}
          {busy ? "Processing…" : "Upload drawing"}
        </button>
      </div>
    </form>
  );
}
function AnalysisForm({
  drawings,
  busy,
  onSubmit,
}: {
  drawings: Drawing[];
  busy: boolean;
  onSubmit: (input: Record<string, FormDataEntryValue>) => void;
}) {
  const readyDrawings = drawings.filter((d) => d.status === "ready");
  const revisionsFor = (discipline: Drawing["discipline"]) =>
    readyDrawings
      .filter((d) => d.discipline === discipline)
      .sort(
        (a, b) =>
          a.uploadedAt.localeCompare(b.uploadedAt) ||
          a.revision.localeCompare(b.revision, undefined, { numeric: true }),
      );
  const defaultDiscipline =
    revisionsFor("architecture").length >= 2
      ? "architecture"
      : revisionsFor("structure").length >= 2
        ? "structure"
        : "architecture";
  const [discipline, setDiscipline] =
    useState<Drawing["discipline"]>(defaultDiscipline);
  const revisions = revisionsFor(discipline);
  const [oldId, setOldId] = useState(revisions[0]?.id ?? ""),
    [newId, setNewId] = useState(revisions.at(-1)?.id ?? "");
  const ready = revisions.length >= 2;
  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ oldId, newId });
      }}
    >
      <div className="analysis-steps">
        <span>
          <i>1</i>Read
        </span>
        <ChevronRight size={13} />
        <span>
          <i>2</i>Compare
        </span>
        <ChevronRight size={13} />
        <span>
          <i>3</i>Check
        </span>
        <ChevronRight size={13} />
        <span>
          <i>4</i>Explain
        </span>
      </div>
      <label>
        Comparison discipline
        <select
          value={discipline}
          onChange={(event) => {
            const next = event.target.value as Drawing["discipline"];
            const nextRevisions = revisionsFor(next);
            setDiscipline(next);
            setOldId(nextRevisions[0]?.id ?? "");
            setNewId(nextRevisions.at(-1)?.id ?? "");
          }}
        >
          <option value="architecture">Architecture</option>
          <option value="structure">Structure</option>
        </select>
      </label>
      {!ready && (
        <div className="alert warning">
          Upload at least two processed{" "}
          {discipline === "architecture" ? "Architecture" : "Structure"}{" "}
          revisions before running analysis.
        </div>
      )}
      <label>
        Previous revision
        <select
          name="oldId"
          required
          value={oldId}
          onChange={(event) => setOldId(event.target.value)}
        >
          <option value="" disabled>
            Select previous revision
          </option>
          {revisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.revision}
            </option>
          ))}
        </select>
      </label>
      <label>
        Latest revision
        <select
          name="newId"
          required
          value={newId}
          onChange={(event) => setNewId(event.target.value)}
        >
          <option value="" disabled>
            Select latest revision
          </option>
          {revisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.revision}
            </option>
          ))}
        </select>
      </label>
      <div className="notice small-notice">
        <ShieldCheck size={18} />
        <p>
          Dimension checks plus geometry comparison when dimensions are
          unavailable. Compare revisions within the same discipline. Findings
          require designer validation.
        </p>
      </div>
      <div className="form-footer">
        <span>
          {oldId === newId && ready
            ? "Select two different revisions."
            : "Every finding links back to its source."}
        </span>
        <button
          className="button primary"
          disabled={!ready || busy || oldId === newId}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <ScanLine size={16} />
          )}{" "}
          {busy ? "Analyzing…" : "Analyze drawing set"}
        </button>
      </div>
    </form>
  );
}

function MemoryCard({ memory: m }: { memory: MemoryCase }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="memory-card">
      <div className="memory-card-top">
        <span className="memory-category">
          <BookOpen size={15} />
          {m.category}
        </span>
        <Pill tone={m.demo ? "amber" : "green"}>
          {m.demo ? "Illustrative case" : "Approved"}
        </Pill>
      </div>
      <h3>{m.title}</h3>
      <p>{m.description}</p>
      <div className="memory-source">
        <span>
          PROJECT <strong>{m.project}</strong>
        </span>
        <span>
          DRAWING <strong>{m.drawing}</strong>
        </span>
        <span>
          REFERENCE <strong>{m.reference}</strong>
        </span>
      </div>
      <div className="memory-tags">
        {m.tags.slice(0, 4).map((t) => (
          <Pill key={t}>{t}</Pill>
        ))}
      </div>
      {expanded && (
        <div className="memory-resolution">
          <strong>Approved solution</strong>
          <p>{m.resolution}</p>
          <small>
            {m.approvedBy} · {date(m.approvedAt)}
          </small>
          <p className="helper-text">
            Designer verification required before reuse.
          </p>
        </div>
      )}
      <footer>
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide solution" : "View approved solution"}{" "}
          <ArrowUpRight size={14} />
        </button>
        {m.sourceUrl && (
          <a
            href={m.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-button"
          >
            Source <ArrowUpRight size={14} />
          </a>
        )}
      </footer>
    </article>
  );
}
function MemoryForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: unknown) => void;
}) {
  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.currentTarget));
        onSubmit({
          ...f,
          tags: String(f.tags)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
      }}
    >
      <label>
        Reference title
        <input name="title" required maxLength={160} />
      </label>
      <div className="form-row">
        <label>
          Category
          <select name="category">
            {["Openings", "Structure", "Fabrication", "General"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Source project
          <input name="project" required maxLength={160} />
        </label>
      </div>
      <div className="form-row">
        <label>
          Drawing reference
          <input
            name="drawing"
            required
            maxLength={160}
            placeholder="FW-42 Rev.03"
          />
        </label>
        <label>
          RFI / NCR / standard
          <input
            name="reference"
            required
            maxLength={160}
            placeholder="RFI-017"
          />
        </label>
      </div>
      <label>
        Condition
        <textarea
          name="description"
          required
          minLength={10}
          maxLength={2000}
          rows={2}
        />
      </label>
      <label>
        Approved solution
        <textarea
          name="resolution"
          required
          minLength={10}
          maxLength={4000}
          rows={3}
        />
      </label>
      <label>
        Controlled source link
        <input
          type="url"
          name="sourceUrl"
          required
          placeholder="https://your-document-system/approved-detail"
        />
      </label>
      <label>
        Search tags
        <input name="tags" maxLength={1000} placeholder="Door, Opening, Wall" />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" required /> I have verified this solution against
        the linked approved source.
      </label>
      <div className="form-footer">
        <span>Recorded under your designer identity.</span>
        <button className="button primary" disabled={busy}>
          Add approved reference
        </button>
      </div>
    </form>
  );
}
function SettingsPanel({
  project,
  converterAvailable,
  busy,
  onSave,
}: {
  project: Project;
  converterAvailable: boolean;
  busy: boolean;
  onSave: (tolerance: number, bom: boolean) => void;
}) {
  const [tolerance, setTolerance] = useState(project.tolerance),
    [bom, setBom] = useState(project.bomReleased);
  return (
    <div className="settings-grid">
      <form
        className="panel settings-panel"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(tolerance, bom);
        }}
      >
        <div className="panel-heading">
          <div>
            <h2>Review parameters</h2>
            <p>{project.name}</p>
          </div>
          <SlidersHorizontal size={18} />
        </div>
        <div className="settings-body">
          <label>
            Dimension tolerance (mm)
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              required
              value={tolerance}
              onChange={(e) => setTolerance(Number(e.target.value))}
            />
            <small>
              Differences at or below this tolerance do not produce dimensional
              findings.
            </small>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={bom}
              onChange={(e) => setBom(e.target.checked)}
            />{" "}
            Fabrication / BOM has been confirmed as released
          </label>
          <p className="helper-text">
            When confirmed, findings include potential impact on released BOM /
            fabrication items. This does not establish an item-level BOM link.
          </p>
          <button className="button primary" disabled={busy}>
            <Check size={16} /> Save parameters
          </button>
        </div>
      </form>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>CAD processing</h2>
            <p>Workspace capabilities</p>
          </div>
          <Layers3 size={18} />
        </div>
        <div className="settings-body">
          <div className="capability-row">
            <span>ASCII DXF extraction</span>
            <Pill tone="green">Available</Pill>
          </div>
          <div className="capability-row">
            <span>DWG conversion</span>
            <Pill tone={converterAvailable ? "green" : "amber"}>
              {converterAvailable ? "Configured" : "Setup needed"}
            </Pill>
          </div>
          <p className="helper-text">
            {converterAvailable
              ? "DWG conversion is available. Click Retry in the drawing library to process saved originals."
              : "The Docker app includes DWG conversion. Start it, or install LibreDWG / ODA File Converter locally, then refresh this page."}
          </p>
          <div className="settings-note">
            <ShieldCheck size={18} />
            <p>
              Review decisions are recorded with your identity and timestamp.
              Drawing approval and release remain designer responsibilities.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
function IssueDrawer({
  issue: i,
  drawings,
  memory,
  onClose,
  onReview,
  busy,
}: {
  issue: Issue;
  drawings: Drawing[];
  memory: MemoryCase[];
  onClose: () => void;
  onReview: (
    id: string,
    status: ReviewStatus,
    notes: string,
    expectedVersion: number,
  ) => void;
  busy: boolean;
}) {
  const [notes, setNotes] = useState(i.notes),
    [status, setStatus] = useState<ReviewStatus>(i.status);
  useEffect(() => {
    setNotes(i.notes);
    setStatus(i.status);
  }, [i.id, i.notes, i.status]);
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const noteRequired = status !== "open";
  const missingNote = noteRequired && !notes.trim();
  const similar = memory.filter((m) =>
    m.tags.some((t) => t.toLowerCase() === i.kind.toLowerCase() || t === i.tag),
  );
  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="issue-drawer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Review ${i.title}`}
      >
        <header>
          <span className="eyebrow">
            DESIGNER REVIEW · #{String(i.number).padStart(3, "0")}
          </span>
          <button
            className="icon-button"
            aria-label="Close issue review"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="drawer-body">
          <div className="drawer-pills">
            <Pill tone={i.severity === "high" ? "orange" : "amber"}>
              <TriangleAlert size={12} />
              {i.severity} priority
            </Pill>
            <Pill>{i.rule}</Pill>
            {i.category && <Pill>{i.category}</Pill>}
          </div>
          <h2>{i.title}</h2>
          <p className="drawer-description">{i.description}</p>
          <div className="dimension-comparison">
            <div>
              <span>PREVIOUS</span>
              <strong>
                {i.geometry || i.rule.startsWith("GEO-")
                  ? i.geometry
                    ? `${i.geometry.removed} removed`
                    : i.rule === "GEO-02"
                      ? "Present"
                      : "Absent"
                  : dimension(i.previous)}
              </strong>
            </div>
            <ArrowRight size={17} />
            <div>
              <span>LATEST</span>
              <strong>
                {i.geometry || i.rule.startsWith("GEO-")
                  ? i.geometry
                    ? `${i.geometry.added} added`
                    : i.rule === "GEO-01"
                      ? "Present"
                      : "Absent"
                  : dimension(i.current)}
              </strong>
            </div>
          </div>
          {i.evidence && (
            <section className="finding-evidence">
              <h3>Evidence</h3>
              <p>{i.evidence.basis}</p>
              <dl>
                <dt>Confidence</dt>
                <dd>
                  {i.evidence.confidence} <small>(heuristic, not a probability)</small>
                </dd>
                <dt>Tolerance</dt>
                <dd>{i.evidence.tolerance} mm</dd>
                {deltaText(i) && (
                  <>
                    <dt>Change</dt>
                    <dd>{deltaText(i)}</dd>
                  </>
                )}
                {i.evidence.view && (
                  <>
                    <dt>View</dt>
                    <dd>{i.evidence.view}</dd>
                  </>
                )}
                {(i.evidence.previousHandles?.length ||
                  i.evidence.latestHandles?.length) ? (
                  <>
                    <dt>CAD handles</dt>
                    <dd>
                      {[
                        i.evidence.previousHandles?.length &&
                          `previous ${i.evidence.previousHandles.slice(0, 8).join(", ")}`,
                        i.evidence.latestHandles?.length &&
                          `latest ${i.evidence.latestHandles.slice(0, 8).join(", ")}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </dd>
                  </>
                ) : null}
                {i.evidence.items && (
                  <>
                    <dt>Grouped changes</dt>
                    <dd>
                      {i.evidence.items.length +
                        (i.evidence.omittedItems ?? 0)}{" "}
                      — step through them on the canvas
                    </dd>
                  </>
                )}
              </dl>
              {i.evidence.warnings?.map((w) => (
                <p key={w} className="evidence-warning">
                  <TriangleAlert size={12} /> {w}
                </p>
              ))}
            </section>
          )}
          <section>
            <h3>Potential impact</h3>
            <div className="impact-list">
              {i.impact.map((s) => (
                <span key={s}>
                  <span className="status-dot" />
                  {s}
                </span>
              ))}
            </div>
          </section>
          <section>
            <h3>Source drawings</h3>
            <div className="source-drawings">
              {i.drawingIds
                .map((id) => drawings.find((d) => d.id === id))
                .filter(Boolean)
                .map((d) => (
                  <a key={d!.id} href={`/api/drawings/${d!.id}/file`}>
                    <FileText size={16} />
                    <span>
                      {d!.name}
                      <small>
                        {d!.discipline} · {d!.revision}
                      </small>
                    </span>
                    <Download size={14} />
                  </a>
                ))}
            </div>
          </section>
          {similar.length > 0 && (
            <section>
              <h3>
                <BookOpen size={15} /> Similar approved conditions
              </h3>
              {similar.slice(0, 1).map((m) => (
                <div className="similar-case" key={m.id}>
                  <Pill tone={m.demo ? "amber" : "green"}>
                    {m.demo ? "Illustrative reference" : "Approved reference"}
                  </Pill>
                  <strong>{m.title}</strong>
                  <p>{m.resolution}</p>
                  <small>
                    {m.project} · {m.drawing} · {m.reference}
                  </small>
                  {m.sourceUrl && (
                    <a
                      href={m.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-button"
                    >
                      View controlled source <ArrowUpRight size={13} />
                    </a>
                  )}
                  <span className="helper-text">
                    Verify applicability before reuse.
                  </span>
                </div>
              ))}
            </section>
          )}
          <section className="designer-review-section">
            <h3>
              <ShieldCheck size={16} /> Your review decision
            </h3>
            <label>
              Finding status
              <select
                value={status}
                disabled={busy}
                onChange={(e) => setStatus(e.target.value as ReviewStatus)}
              >
                {Object.entries(statusLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Designer notes
              <textarea
                rows={4}
                maxLength={4000}
                placeholder="Record what you verified, your reasoning, and any required follow-up…"
                value={notes}
                disabled={busy}
                aria-required={noteRequired}
                aria-describedby={
                  missingNote ? `review-note-${i.id}` : undefined
                }
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            {missingNote && (
              <p
                id={`review-note-${i.id}`}
                className="alert warning"
                role="status"
              >
                Add a designer note to save this decision. Explain what you
                verified or why you chose {statusLabels[status].toLowerCase()}.
              </p>
            )}
            <p className="helper-text">
              Accepted confirms the finding is valid; it does not resolve it.
              Accepted, Rejected, and Investigating require a designer note.
            </p>
            {i.reviewedBy && (
              <p className="review-attribution">
                <CheckCheck size={14} />
                {i.reviewedBy} · {formatTimestamp(i.reviewedAt!)}
              </p>
            )}
          </section>
        </div>
        <footer>
          <button className="button" onClick={onClose}>
            Close
          </button>
          <button
            className="button primary"
            disabled={busy || missingNote}
            onClick={() => onReview(i.id, status, notes, i.version ?? 0)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <ShieldCheck size={15} />
            )}{" "}
            Save decision
          </button>
        </footer>
      </aside>
    </div>
  );
}
