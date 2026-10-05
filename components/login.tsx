"use client";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ShieldCheck,
  Layers3,
  ScanLine,
  Eye,
  EyeOff,
} from "lucide-react";
import Link from "next/link";
export default function Login({
  demo,
  signup = false,
  reset,
}: {
  demo: boolean;
  signup?: boolean;
  reset?: "request" | "confirm";
}) {
  const [email, setEmail] = useState(demo ? "designer@formiq.ai" : ""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(demo ? "Formiq@2026" : ""),
    [showPassword, setShowPassword] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [token, setToken] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (reset !== "confirm") return;
    const value =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    if (/^[a-f0-9]{64}$/.test(value)) setToken(value);
    else setError("This reset link is invalid. Request a new link.");
  }, [reset]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (reset === "confirm" && password !== confirmation)
        throw new Error("The passwords do not match.");
      const endpoint =
        reset === "request"
          ? "/api/auth/forgot-password"
          : reset === "confirm"
            ? "/api/auth/reset-password"
            : signup
              ? "/api/auth/register"
              : "/api/auth/login";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reset === "request"
            ? { email }
            : reset === "confirm"
              ? { token, password }
              : { email, password, ...(signup ? { name } : {}) },
        ),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (reset) {
        setMessage(data.message);
        setBusy(false);
        setPassword("");
        setConfirmation("");
        if (reset === "confirm")
          window.history.replaceState(null, "", "/reset-password");
        return;
      }
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
        <div className="login-story-content">
          <span className="eyebrow light-text">CAD REVISION ASSURANCE</span>
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
          <h2>
            {reset === "request"
              ? "Forgot your password?"
              : reset === "confirm"
                ? "Choose a new password."
                : signup
                  ? "Create your account."
                  : "Welcome to Kumkang Kind Ai'Tech."}
          </h2>
          <p>
            {reset === "request"
              ? "Enter your account email to receive a password reset link."
              : reset === "confirm"
                ? "Use at least 10 characters for your new password."
                : signup
                  ? "Start your own design assurance workspace."
                  : "Sign in to your design assurance workspace."}
          </p>
          {!message && (
            <>
              {signup && (
                <label>
                  Full name
                  <input
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={100}
                    placeholder="Your name"
                  />
                </label>
              )}
              {reset !== "confirm" && (
                <label>
                  Email address
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={160}
                    placeholder="you@company.com"
                  />
                </label>
              )}
              {reset !== "request" && (
                <label>
                  Password
                  <span className="password-input">
                    <input
                      type={showPassword ? "text" : "password"}
                      name="password"
                      autoComplete={
                        signup || reset === "confirm"
                          ? "new-password"
                          : "current-password"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={signup || reset === "confirm" ? 10 : undefined}
                      maxLength={200}
                      placeholder={
                        signup || reset === "confirm"
                          ? "At least 10 characters"
                          : undefined
                      }
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                      title={showPassword ? "Hide password" : "Show password"}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                    >
                      {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                    </button>
                  </span>
                </label>
              )}
              {reset === "confirm" && (
                <label>
                  Confirm new password
                  <input
                    type={showPassword ? "text" : "password"}
                    name="confirmation"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    required
                    minLength={10}
                    maxLength={200}
                  />
                </label>
              )}
              {!signup && !reset && (
                <p className="auth-switch">
                  <Link href="/forgot-password">Forgot password?</Link>
                </p>
              )}
              {error && (
                <div role="alert" className="alert error">
                  {error}
                </div>
              )}
              <button
                disabled={busy || (reset === "confirm" && !token)}
                className="button primary full"
                type="submit"
              >
                {reset
                  ? busy
                    ? "Please wait…"
                    : reset === "request"
                      ? "Send reset link"
                      : "Update password"
                  : busy
                    ? signup
                      ? "Creating account…"
                      : "Signing in…"
                    : signup
                      ? "Create account"
                      : "Enter workspace"}
                <ArrowRight size={17} />
              </button>
            </>
          )}
          {message && (
            <div role="status" className="alert">
              {message}
            </div>
          )}
          <p className="auth-switch">
            {reset
              ? ""
              : signup
                ? "Already have an account? "
                : "New to Kumkang Kind Ai'Tech? "}
            <Link href={reset || signup ? "/login" : "/register"}>
              {reset
                ? "Back to sign in"
                : signup
                  ? "Sign in"
                  : "Create an account"}
            </Link>
            {reset === "confirm" && !message && (
              <>
                {" "}
                · <Link href="/forgot-password">Request a new reset link</Link>
              </>
            )}
          </p>
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
