import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Kumkang Kind Ai'Tech — Design Assurance",
  icons: { icon: "/brand-logo.jpeg", apple: "/brand-logo.jpeg" },
  description:
    "Architecture and structural drawing revision review. Every revision traced. Every risk visible.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Browser extensions may add body attributes before React hydrates. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
