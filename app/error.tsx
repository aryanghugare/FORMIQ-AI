"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <div className="brand">
        <span className="brand-icon">F</span> FORMIQ <small>AI</small>
      </div>
      <h1>The workspace couldn’t load.</h1>
      <p>
        Something went wrong while loading your workspace. Please try again
        or reload the page.
      </p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
