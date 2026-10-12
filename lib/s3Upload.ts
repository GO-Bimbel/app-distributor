// Browser-side chunked upload to S3-compatible storage (multipart upload).
//
// Sending an APK in one PUT means any network blip restarts it from 0%. Here
// each part is its own presigned PUT, a few run in parallel, and a failed part
// is retried on its own. The server stitches the parts together afterwards,
// reading their ETags itself, so the bucket's CORS only needs to allow PUT.

import { startS3Upload, completeS3Upload, abortS3Upload } from "@/app/actions/storage";

// R2 requires every part but the last to be the same size; S3 needs >= 5 MiB.
export const S3_PART_SIZE = 10 * 1024 * 1024;
const CONCURRENCY = 3;
const MAX_RETRIES = 5;

type PartResult = { kind: "ok" } | { kind: "retryable"; reason: string } | { kind: "fatal"; reason: string };

function putPart(url: string, body: Blob, onProgress: (loaded: number) => void): Promise<PartResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const s = xhr.status;
      if (s >= 200 && s < 300) resolve({ kind: "ok" });
      else if (s === 408 || s === 429 || s >= 500) resolve({ kind: "retryable", reason: `storage responded ${s}` });
      else resolve({ kind: "fatal", reason: `Upload failed (HTTP ${s})` });
    };
    xhr.onerror = () => resolve({ kind: "retryable", reason: "network error" });
    xhr.ontimeout = () => resolve({ kind: "retryable", reason: "timed out" });
    xhr.send(body);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadToS3(
  applicationId: string,
  file: File,
  contentType: string,
  callbacks: {
    onProgress: (pct: number) => void;
    /** Called before each retry; `null` once a retried part goes through. */
    onRetry: (info: { attempt: number; max: number; reason: string } | null) => void;
  }
): Promise<{ storageConnectionId: string; storageObjectKey: string }> {
  const partCount = Math.max(1, Math.ceil(file.size / S3_PART_SIZE));
  const target = await startS3Upload(applicationId, file.name, contentType, partCount);
  if (!target.ok) throw new Error(target.message);
  const { uploadId, partUrls, objectKey, storageConnectionId } = target;

  const loaded = new Array<number>(partCount).fill(0);
  const report = () =>
    callbacks.onProgress(
      Math.min(99, Math.round((loaded.reduce((a, b) => a + b, 0) / Math.max(file.size, 1)) * 100))
    );

  async function uploadPart(i: number) {
    const body = file.slice(i * S3_PART_SIZE, (i + 1) * S3_PART_SIZE);
    for (let failures = 0; ; ) {
      const result = await putPart(partUrls[i], body, (n) => {
        loaded[i] = n;
        report();
      });
      if (result.kind === "ok") {
        loaded[i] = body.size;
        if (failures) callbacks.onRetry(null);
        return;
      }
      if (result.kind === "fatal") throw new Error(result.reason);
      failures++;
      if (failures > MAX_RETRIES) {
        throw new Error(`Upload failed after ${MAX_RETRIES} retries (${result.reason})`);
      }
      loaded[i] = 0;
      report();
      callbacks.onRetry({ attempt: failures, max: MAX_RETRIES, reason: result.reason });
      await wait(1000 * 2 ** (failures - 1));
    }
  }

  try {
    let next = 0;
    // Each worker pulls the next part index; the first failure stops the rest.
    let failed = false;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, partCount) }, async () => {
        while (!failed && next < partCount) {
          const i = next++;
          try {
            await uploadPart(i);
          } catch (err) {
            failed = true;
            throw err;
          }
        }
      })
    );

    const done = await completeS3Upload(storageConnectionId, objectKey, uploadId, partCount);
    if (!done.ok) throw new Error(done.message);
  } catch (err) {
    abortS3Upload(storageConnectionId, objectKey, uploadId).catch(() => {});
    throw err;
  }

  callbacks.onProgress(100);
  return { storageConnectionId, storageObjectKey: objectKey };
}
