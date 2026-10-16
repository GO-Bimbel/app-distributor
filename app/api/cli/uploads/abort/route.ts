import { NextResponse } from "next/server";
import * as z from "zod";
import { requireApiPublisher } from "@/lib/apiAuth";
import { s3CredsFor } from "@/lib/buildPublish";
import { abortS3MultipartUpload } from "@/lib/storage/s3";

const AbortSchema = z.object({
  storageConnectionId: z.string().min(1),
  objectKey: z.string().min(1),
  uploadId: z.string().min(1),
});

/** Best effort: frees the parts already stored when the CLI gives up. */
export async function POST(req: Request) {
  const auth = await requireApiPublisher(req);
  if ("error" in auth) return auth.error;

  const parsed = AbortSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { storageConnectionId, objectKey, uploadId } = parsed.data;

  try {
    await abortS3MultipartUpload(await s3CredsFor(storageConnectionId), objectKey, uploadId);
  } catch (err) {
    console.error("cli abortS3Upload failed", err);
  }
  return NextResponse.json({ ok: true });
}
