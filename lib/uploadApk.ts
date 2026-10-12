// Browser-side: sends an APK to the application's connected storage and
// returns where it landed. Shared by Create build and Replace APK.

import { createGDriveUploadSession } from "@/app/actions/storage";
import { uploadToDriveSession } from "@/lib/driveUpload";
import { uploadToS3 } from "@/lib/s3Upload";

export type StorageProviderKind = "GOOGLE_DRIVE" | "S3_COMPATIBLE";
export type RetryInfo = { attempt: number; max: number; reason: string };

export async function uploadApk(
  applicationId: string,
  provider: StorageProviderKind,
  file: File,
  callbacks: { onProgress: (pct: number) => void; onRetry: (info: RetryInfo | null) => void }
): Promise<{ storageConnectionId: string; storageObjectKey: string }> {
  const contentType = file.type || "application/vnd.android.package-archive";

  if (provider === "S3_COMPATIBLE") {
    // Chunked: a failed part is retried on its own instead of restarting.
    const result = await uploadToS3(applicationId, file, contentType, callbacks);
    callbacks.onRetry(null);
    return result;
  }

  const session = await createGDriveUploadSession(applicationId, file.name, contentType);
  if (!session.ok) throw new Error(session.message);
  // Chunked + resumable: a dropped connection resumes instead of restarting.
  const storageObjectKey = await uploadToDriveSession(session.uploadUrl, file, contentType, callbacks);
  callbacks.onRetry(null);
  return { storageConnectionId: session.storageConnectionId, storageObjectKey };
}
