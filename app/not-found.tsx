import Link from "next/link";
export default function NotFound() {
  return (
    <main className="error-page">
      <h1>Page not found</h1>
      <p>This page is not part of the workspace.</p>
      <Link className="button primary" href="/">
        Back to workspace
      </Link>
    </main>
  );
}
