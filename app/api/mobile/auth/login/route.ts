import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/session";
import { LoginFormSchema } from "@/app/lib/definitions";

/** Same credential check as the web login action, but returns a Bearer token instead of a cookie. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const validated = LoginFormSchema.safeParse(body);
  if (!validated.success) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 400 });
  }

  const { email, password } = validated.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.passwordHash === null && password.trim().toLowerCase() === user.email.toLowerCase()) {
    return NextResponse.json(
      {
        error: "Your password was reset. Sign in on the web to set a new password.",
        code: "PASSWORD_RESET_REQUIRED",
      },
      { status: 403 }
    );
  }
  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const token = await encrypt({ userId: user.id, role: user.role, expiresAt });

  return NextResponse.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}
