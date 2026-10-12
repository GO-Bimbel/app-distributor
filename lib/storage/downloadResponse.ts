import "server-only";
import { NextResponse } from "next/server";
import type { Build, StorageConnection } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { presignS3Get, type S3Credentials } from "@/lib/storage/s3";
import { fetchDriveFileStream, getPublicDriveDownloadUrl, DriveAccessRevokedError } from "@/lib/storage/gdrive";
import { attachmentDisposition } from "@/lib/format";

/** Cookie the DownloadButton polls for to learn the file has started arriving. */
export const DOWNLOAD_COOKIE_PREFIX = "dl_";
const DOWNLOAD_ID_RE = /^[a-z0-9]{8,32}$/i;

type DownloadableBuild = Pick<Build, "storageObjectKey" | "apkFileName"> & {
  storageConnection: StorageConnection | null;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Browsers navigate to the download, so they get a readable page; API clients (mobile) get JSON. */
function unavailable(req: Request, status: number, title: string, detail: string) {
  if (!req.headers.get("accept")?.includes("text/html")) {
    return NextResponse.json({ error: `${title}. ${detail}` }, { status });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fafafa;color:#1a1a1a}main{max-width:460px;margin:0 auto}h1{font-size:19px;margin:0 0 8px}p{margin:0 0 16px;color:#555}a{color:inherit}@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}p{color:#aaa}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><a href="javascript:history.back()">← Go back</a></p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * Responds with the build's APK — a redirect to a presigned URL for S3, a
 * proxied stream for Google Drive. When the request carries `?dl=<id>`, a
 * short-lived cookie marks the moment the response starts, since a page can't
 * otherwise observe when a browser download begins.
 */
export async function downloadResponse(req: Request, build: DownloadableBuild) {
  if (!build.storageConnection || !build.storageObjectKey) {
    return NextResponse.json({ error: "Build file not found" }, { status: 404 });
  }

  const connection = build.storageConnection;
  const secret = decryptSecret(connection.encryptedCredentials);
  let res: NextResponse;

  if (connection.provider === "S3_COMPATIBLE") {
    const url = await presignS3Get(JSON.parse(secret) as S3Credentials, build.storageObjectKey);
    res = NextResponse.redirect(url);
  } else {
    const { refreshToken } = JSON.parse(secret) as { refreshToken: string };
    try {
      res = await driveResponse(refreshToken, build.storageObjectKey, build.apkFileName);
    } catch (err) {
      console.error("download: Drive fetch failed", err);
      return err instanceof DriveAccessRevokedError
        ? unavailable(
            req,
            503,
            "Download temporarily unavailable",
            `The Google Drive account that stores this APK (${connection.accountLabel}) needs to be reconnected in BuildApp. Let the team know — this link will work again once it's reconnected.`
          )
        : unavailable(
            req,
            502,
            "Couldn't fetch the APK",
            "Google Drive didn't return the file. Try again in a minute; if it keeps failing, let the team know."
          );
    }
  }

  const dl = new URL(req.url).searchParams.get("dl");
  if (dl && DOWNLOAD_ID_RE.test(dl)) {
    res.cookies.set(`${DOWNLOAD_COOKIE_PREFIX}${dl}`, "1", { path: "/", maxAge: 60, sameSite: "lax" });
  }
  return res;
}

/**
 * Redirects to a public Drive download link so the APK bytes skip Vercel's
 * Fast Origin Transfer. Proxies the file instead when the link can't be
 * created (e.g. a Workspace policy that forbids link sharing).
 */
async function driveResponse(refreshToken: string, fileId: string, apkFileName: string | null) {
  try {
    return NextResponse.redirect(await getPublicDriveDownloadUrl(refreshToken, fileId));
  } catch (err) {
    if (err instanceof DriveAccessRevokedError) throw err;
    console.error("download: Drive public link failed, proxying instead", err);
  }
  const upstream = await fetchDriveFileStream(refreshToken, fileId);
  const headers = new Headers({
    "Content-Type":
      upstream.headers.get("content-type") ?? "application/vnd.android.package-archive",
    "Content-Disposition": attachmentDisposition(apkFileName ?? "build.apk"),
  });
  // Lets the browser show real progress and time remaining.
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  return new NextResponse(upstream.body, { headers });
}
