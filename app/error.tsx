"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
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
      <h1>The workspace couldn’t load.</h1>
      <p>
        Something went wrong while loading your workspace. Please try again or
        reload the page.
      </p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
