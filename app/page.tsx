import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import Workspace from "@/components/workspace";
import { loadWorkspace } from "@/lib/workspace";
export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <Workspace initialData={loadWorkspace(user)} />;
}
