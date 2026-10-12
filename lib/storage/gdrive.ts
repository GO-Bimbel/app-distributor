import "server-only";
import { headers } from "next/headers";

const SCOPES = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3";
const UPLOAD_FOLDER_NAME = "distribution";

function oauthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleDriveConfigured() {
  return oauthConfig() !== null;
}

export function buildAuthUrl(state: string) {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("Google Drive OAuth is not configured");
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCodeForTokens(code: string) {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("Google Drive OAuth is not configured");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

/** Google no longer accepts the stored refresh token — the account must be reconnected. */
export class DriveAccessRevokedError extends Error {
  constructor() {
    super("Google Drive access has expired or was revoked.");
    this.name = "DriveAccessRevokedError";
  }
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("Google Drive OAuth is not configured");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    // invalid_grant: expired (e.g. issued while the OAuth app was in Testing), revoked, or password changed.
    if (body.error === "invalid_grant") throw new DriveAccessRevokedError();
    throw new Error(
      `Failed to refresh access token: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim()
    );
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function ensureDistributionFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${UPLOAD_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const list = await fetch(`${DRIVE_URL}/files?q=${q}&fields=files(id)&pageSize=1&spaces=drive`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok) throw new Error(`Drive list failed: ${list.status}`);
  const data = await list.json() as { files: { id: string }[] };
  if (data.files[0]?.id) return data.files[0].id;

  const create = await fetch(`${DRIVE_URL}/files?fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: UPLOAD_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!create.ok) throw new Error(`Drive folder create failed: ${create.status}`);
  const folder = await create.json() as { id: string };
  if (!folder.id) throw new Error("Failed to create the Drive distribution folder");
  return folder.id;
}

export async function createResumableUploadSession(
  refreshToken: string,
  filename: string,
  mimeType: string
) {
  const accessToken = await getAccessToken(refreshToken);
  const folderId = await ensureDistributionFolder(accessToken);

  const hdrs = await headers();
  const origin =
    hdrs.get("origin") ??
    `${hdrs.get("x-forwarded-proto") ?? "http"}://${hdrs.get("host")}`;

  const res = await fetch(`${UPLOAD_URL}/files?uploadType=resumable`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      Origin: origin,
    },
    body: JSON.stringify({ name: filename, parents: [folderId] }),
  });
  if (!res.ok) throw new Error(`Failed to open Drive upload session: ${res.status}`);
  const sessionUrl = res.headers.get("location");
  if (!sessionUrl) throw new Error("Drive did not return an upload session URL");
  return sessionUrl;
}

export type DriveFileSummary = {
  id: string;
  name: string;
  size: number;
  createdTime: string | null;
};

export async function listDistributionFolderFiles(
  refreshToken: string
): Promise<DriveFileSummary[]> {
  const accessToken = await getAccessToken(refreshToken);
  const folderId = await ensureDistributionFolder(accessToken);

  const results: DriveFileSummary[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,size,createdTime)",
      pageSize: "1000",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`${DRIVE_URL}/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
    const data = await res.json() as {
      nextPageToken?: string;
      files: { id: string; name?: string; size?: string; createdTime?: string }[];
    };
    for (const f of data.files) {
      if (f.id) {
        results.push({
          id: f.id,
          name: f.name ?? f.id,
          size: f.size ? Number(f.size) : 0,
          createdTime: f.createdTime ?? null,
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return results;
}

export async function trashDriveFile(refreshToken: string, fileId: string) {
  const accessToken = await getAccessToken(refreshToken);
  const res = await fetch(`${DRIVE_URL}/files/${fileId}?fields=id`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`Drive trash failed: ${res.status}`);
}

export async function getAccountEmail(refreshToken: string) {
  const accessToken = await getAccessToken(refreshToken);
  const res = await fetch(`${DRIVE_URL}/about?fields=user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return "Google Drive";
  const data = await res.json() as { user?: { emailAddress?: string } };
  return data.user?.emailAddress ?? "Google Drive";
}

/**
 * Grants "anyone with the link" read access to the file and returns a URL
 * that downloads it straight from Google, so the bytes never pass through
 * our functions. Creating the same `anyone` permission again is a no-op.
 */
export async function getPublicDriveDownloadUrl(refreshToken: string, fileId: string) {
  const accessToken = await getAccessToken(refreshToken);
  const res = await fetch(`${DRIVE_URL}/files/${fileId}/permissions?fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) throw new Error(`Drive share failed: ${res.status}`);
  // confirm=t skips the "can't scan for viruses" interstitial on large files.
  const params = new URLSearchParams({ id: fileId, export: "download", confirm: "t" });
  return `https://drive.usercontent.google.com/download?${params}`;
}

export async function fetchDriveFileStream(refreshToken: string, fileId: string) {
  const accessToken = await getAccessToken(refreshToken);
  const res = await fetch(`${DRIVE_URL}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok || !res.body) throw new Error(`Failed to fetch Drive file: ${res.status}`);
  return res;
}
