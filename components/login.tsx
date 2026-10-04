"use client";
import { useState } from "react";
import { ArrowRight, ShieldCheck, Layers3, ScanLine } from "lucide-react";
export default function Login({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState(demo ? "designer@formiq.ai" : ""),
    [password, setPassword] = useState(demo ? "Formiq@2026" : ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to sign in.");
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand light">
          <span className="brand-icon">F</span> FORMIQ <small>AI</small>
        </div>
        <div className="login-story-content">
          <span className="eyebrow light-text">FORMWORK DESIGN ASSURANCE</span>
          <h1>
            Every revision traced.
            <br />
            Every risk visible.
          </h1>
          <p>
            From complex drawings to confident decisions. A clearer way to
            review, coordinate, and build.
          </p>
          <div className="login-blueprint">
            <div className="bp-room one">LIVING / DINING</div>
            <div className="bp-room two">BEDROOM 01</div>
            <div className="bp-room three">KITCHEN</div>
            <div className="bp-door">
              D14 <span>900 → 1000 mm</span>
            </div>
            <div className="bp-check">
              <ScanLine size={18} /> Revision detected
            </div>
          </div>
          <div className="login-points">
            <span>
              <Layers3 size={17} /> CAD revision intelligence
            </span>
            <span>
              <ShieldCheck size={17} /> Designer-led validation
            </span>
          </div>
        </div>
        <div className="login-foot">
          KUMKANG KIND <span>AI INNOVATION CHALLENGE 2026</span>
        </div>
      </section>
      <section className="login-form-wrap">
        <form onSubmit={submit} className="login-form">
          <span className="pill green">
            <span className="status-dot" /> DESIGN WORKSPACE
          </span>
          <h2>Welcome to FORMIQ.</h2>
          <p>Sign in to your design assurance workspace.</p>
          <label>
            Email address
            <input
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@company.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <div role="alert" className="alert error">
              {error}
            </div>
          )}
          <button disabled={busy} className="button primary full" type="submit">
            {busy ? "Signing in…" : "Enter workspace"}
            <ArrowRight size={17} />
          </button>
          {demo && (
            <div className="demo-login">
              <strong>Explore the working demo</strong>
              <p>
                The credentials above open an illustrative project with real DXF
                sample drawings and editable review findings.
              </p>
              <code>designer@formiq.ai · Formiq@2026</code>
            </div>
          )}
          <div className="approval-note">
            <ShieldCheck size={16} />
            <span>
              AI assists. Designers approve.
              <br />
              Your judgment stays at the centre.
            </span>
          </div>
        </form>
      </section>
    </main>
  );
}
