import Login from "@/components/login";
export const metadata = {
  title: "Choose a new password | Kumkang Kind Ai'Tech",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function Page() {
  return <Login demo={false} reset="confirm" />;
}
