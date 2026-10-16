import { NextResponse } from "next/server";
import { requireApiPublisher } from "@/lib/apiAuth";

/** Lets the CLI check its token and whether GitHub comments will work. */
export async function GET(req: Request) {
  const auth = await requireApiPublisher(req);
  if ("error" in auth) return auth.error;
  return NextResponse.json({ user: auth.user });
}
