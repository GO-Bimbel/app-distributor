import { NextResponse } from "next/server";
import * as z from "zod";
import { prisma } from "@/lib/db";
import { requireApiPublisher } from "@/lib/apiAuth";
import {
  MAX_S3_PARTS,
  openGDriveUpload,
  openS3Upload,
  resolveConnectionForApplication,
} from "@/lib/buildPublish";

// Same part size the browser uses (lib/s3Upload.ts): R2 wants equal parts, S3 >= 5 MiB.
const S3_PART_SIZE = 10 * 1024 * 1024;

const StartUploadSchema = z.object({
  app: z.string().min(1),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1).optional(),
});

/**
 * Opens an upload into the app's connected storage. The CLI then sends the
 * file straight to storage (S3 part URLs or a Drive resumable session) and
 * comes back to /complete (S3 only) and /api/cli/builds.
 */
export async function POST(req: Request) {
  const auth = await requireApiPublisher(req);
  if ("error" in auth) return auth.error;

  const parsed = StartUploadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { app, fileName, sizeBytes }." }, { status: 400 });
  }
  const { app: slug, fileName, sizeBytes } = parsed.data;
  const contentType = parsed.data.contentType ?? "application/vnd.android.package-archive";

  const app = await prisma.application.findUnique({ where: { slug }, select: { id: true } });
  if (!app) return NextResponse.json({ error: `Application "${slug}" not found.` }, { status: 404 });

  let provider;
  try {
    provider = (await resolveConnectionForApplication(app.id)).provider;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No storage." }, { status: 409 });
  }

  if (provider === "S3_COMPATIBLE") {
    const partCount = Math.max(1, Math.ceil(sizeBytes / S3_PART_SIZE));
    if (partCount > MAX_S3_PARTS) {
      return NextResponse.json({ error: "APK is too large." }, { status: 413 });
    }
    const target = await openS3Upload(app.id, fileName, contentType, partCount);
    if (!target.ok) return NextResponse.json({ error: target.message }, { status: 502 });
    return NextResponse.json({ provider, partSize: S3_PART_SIZE, contentType, ...target });
  }

  const target = await openGDriveUpload(app.id, fileName, contentType);
  if (!target.ok) return NextResponse.json({ error: target.message }, { status: 502 });
  return NextResponse.json({ provider, contentType, ...target });
}
