import Login from "@/components/login";
export const metadata = {
  title: "Reset password | Kumkang Kind Ai'Tech",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <Login demo={false} reset="request" />;
}
