import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getResetUserId } from "@/lib/session";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage() {
  const userId = await getResetUserId();
  if (!userId) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!user || user.passwordHash !== null) redirect("/login");

  return <ResetPasswordForm email={user.email} />;
}
