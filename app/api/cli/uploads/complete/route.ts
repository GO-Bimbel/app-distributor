import { NextResponse } from "next/server";
import * as z from "zod";
import { requireApiPublisher } from "@/lib/apiAuth";
import { s3CredsFor } from "@/lib/buildPublish";
import { completeS3MultipartUpload } from "@/lib/storage/s3";
import { storageErrorMessage } from "@/lib/storage/errors";

const CompleteSchema = z.object({
  storageConnectionId: z.string().min(1),
  objectKey: z.string().min(1),
  uploadId: z.string().min(1),
  partCount: z.number().int().positive(),
});

/** Stitches the uploaded S3 parts together (the server reads their ETags itself). */
export async function POST(req: Request) {
  const auth = await requireApiPublisher(req);
  if ("error" in auth) return auth.error;

  const parsed = CompleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { storageConnectionId, objectKey, uploadId, partCount } = parsed.data;

  try {
    await completeS3MultipartUpload(await s3CredsFor(storageConnectionId), objectKey, uploadId, partCount);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("cli completeS3Upload failed", err);
    return NextResponse.json({ error: storageErrorMessage(err, null) }, { status: 502 });
  }
}
