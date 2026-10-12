import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decrypt } from "@/lib/session";

const PUBLIC_ROUTES = new Set(["/login", "/signup", "/reset-password"]);
const PUBLIC_PREFIXES = ["/share/"];
const COOKIE_NAME = "buildapp_session";

export default async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isPublicRoute = PUBLIC_ROUTES.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  const session = await decrypt(cookie);

  if (!isPublicRoute && !session?.userId) {
    const url = new URL("/login", req.nextUrl);
    url.searchParams.set("from", path);
    return NextResponse.redirect(url);
  }

  if (PUBLIC_ROUTES.has(path) && session?.userId) {
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|.*\\.(?:png|svg|ico)$).*)"],
};
