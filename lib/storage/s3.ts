import "server-only";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
};

function client(creds: S3Credentials) {
  return new S3Client({
    region: creds.region || "auto",
    endpoint: creds.endpoint || undefined,
    forcePathStyle: !!creds.endpoint,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    // The SDK defaults to adding an x-amz-checksum-* param to presigned
    // requests, which the browser's plain XHR PUT can't reproduce and would
    // break the signature. Presigned URLs don't need this validation.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

/**
 * Opens a multipart upload and presigns one PUT URL per part, so the browser
 * can send the APK in chunks and retry a failed chunk on its own. URLs live
 * long enough for a large APK on a slow connection.
 */
export async function startS3MultipartUpload(
  creds: S3Credentials,
  key: string,
  contentType: string,
  partCount: number
) {
  const c = client(creds);
  const { UploadId } = await c.send(
    new CreateMultipartUploadCommand({ Bucket: creds.bucket, Key: key, ContentType: contentType })
  );
  if (!UploadId) throw new Error("Storage did not return a multipart upload id");
  const partUrls = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      getSignedUrl(
        c,
        new UploadPartCommand({ Bucket: creds.bucket, Key: key, UploadId, PartNumber: i + 1 }),
        { expiresIn: 60 * 60 * 2 }
      )
    )
  );
  return { uploadId: UploadId, partUrls };
}

/**
 * Stitches the uploaded parts together. ETags come from ListParts rather than
 * the browser, so the bucket's CORS needn't expose the ETag header.
 */
export async function completeS3MultipartUpload(
  creds: S3Credentials,
  key: string,
  uploadId: string,
  expectedParts: number
) {
  const c = client(creds);
  const parts: CompletedPart[] = [];
  let marker: string | undefined;
  do {
    const res = await c.send(
      new ListPartsCommand({
        Bucket: creds.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      })
    );
    for (const p of res.Parts ?? []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag });
    marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (marker);

  if (parts.length !== expectedParts) {
    throw new Error(`Upload incomplete: storage has ${parts.length} of ${expectedParts} parts`);
  }
  parts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
  await c.send(
    new CompleteMultipartUploadCommand({
      Bucket: creds.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

export async function abortS3MultipartUpload(creds: S3Credentials, key: string, uploadId: string) {
  await client(creds).send(
    new AbortMultipartUploadCommand({ Bucket: creds.bucket, Key: key, UploadId: uploadId })
  );
}

export async function presignS3Get(creds: S3Credentials, key: string) {
  const cmd = new GetObjectCommand({ Bucket: creds.bucket, Key: key });
  return getSignedUrl(client(creds), cmd, { expiresIn: 60 * 5 });
}

export type S3ObjectSummary = { key: string; size: number; lastModified: Date | null };

/** Lists every object in the bucket — the bucket may be shared with things
 *  outside BuildApp, so callers must cross-reference against known build
 *  object keys rather than assuming everything listed here is ours. */
export async function listS3Objects(creds: S3Credentials): Promise<S3ObjectSummary[]> {
  const results: S3ObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client(creds).send(
      new ListObjectsV2Command({
        Bucket: creds.bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) {
        results.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? null,
        });
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return results;
}

export async function deleteS3Object(creds: S3Credentials, key: string) {
  await client(creds).send(new DeleteObjectCommand({ Bucket: creds.bucket, Key: key }));
}
