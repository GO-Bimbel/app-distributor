import "server-only";
import { NextResponse } from "next/server";
import { decrypt, getSessionCookie } from "./session";
import { prisma } from "./db";

/**
 * Verifies either a mobile Bearer token or the web's cookie session, so a
 * single route can serve both the Android app and the browser.
 */
export async function verifyBearerOrSession(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return decrypt(auth.slice("Bearer ".length));
  }
  return decrypt(await getSessionCookie());
}

/**
 * The publisher behind a Bearer token or cookie, read fresh from the database
 * (the token's role may be stale). Returns a ready error response otherwise.
 */
export async function requireApiPublisher(req: Request) {
  const session = await verifyBearerOrSession(req);
  const user = session?.userId
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, name: true, email: true, role: true, githubLogin: true },
      })
    : null;
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  if (user.role !== "PUBLISHER") {
    return {
      error: NextResponse.json({ error: "This action requires the Publisher role." }, { status: 403 }),
    } as const;
  }
  return { user } as const;
}
