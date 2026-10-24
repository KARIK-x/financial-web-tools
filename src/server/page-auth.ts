import { redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "./auth";
import { can, type Permission } from "@/lib/permissions";

/**
 * Page-level guard. Unlike requirePermission (used by server actions, where a
 * thrown error becomes a form error), a page should render a clear refusal
 * rather than a 500. Unauthenticated users go to the login screen; signed-in
 * users without the permission land on /no-access.
 */
export async function requirePagePermission(permission?: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (permission && !can(user.role, permission, user.permissions)) {
    redirect(`/no-access?permission=${encodeURIComponent(permission)}`);
  }
  return user;
}
