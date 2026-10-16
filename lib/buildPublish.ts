import "server-only";
// Storage targets and build publishing, shared by the web's server actions
// (app/actions/storage.ts) and the CLI API (app/api/cli/*). Callers check who
// is asking first; nothing here reads the session.

import { randomBytes } from "crypto";
import type * as z from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { absoluteUrl } from "@/lib/url";
import { decryptSecret } from "@/lib/crypto";
import { startS3MultipartUpload } from "@/lib/storage/s3";
import type { S3Credentials } from "@/lib/storage/s3";
import { createResumableUploadSession } from "@/lib/storage/gdrive";
import { storageErrorMessage } from "@/lib/storage/errors";
import { postBuildComment } from "@/lib/github";
import { getGithubToken, NO_GITHUB_TOKEN_MESSAGE } from "@/lib/githubToken";
import type { BuildFormSchema, TicketRefSchema } from "@/app/lib/definitions";

export type UploadTarget =
  | { ok: true; uploadUrl: string; objectKey?: string; storageConnectionId: string }
  | { ok: false; message: string };

export type S3UploadTarget =
  | {
      ok: true;
      uploadId: string;
      partUrls: string[];
      objectKey: string;
      storageConnectionId: string;
    }
  | { ok: false; message: string };

/** 500 MB APK cap / 5 MiB S3 minimum part size, with headroom. */
export const MAX_S3_PARTS = 200;

export async function resolveConnectionForApplication(applicationId: string) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { defaultStorage: true },
  });
  if (!app) throw new Error("Application not found");

  const connection =
    app.defaultStorage ??
    (await prisma.storageConnection.findFirst({ where: { isDefault: true } }));

  if (!connection) {
    throw new Error(
      "No storage connected. Connect a storage provider from the Storage page first."
    );
  }
  return connection;
}

export async function openS3Upload(
  applicationId: string,
  filename: string,
  contentType: string,
  partCount: number
): Promise<S3UploadTarget> {
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_S3_PARTS) {
    return { ok: false, message: "Invalid upload size." };
  }
  const app = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!app) return { ok: false, message: "Application not found." };

  let connection;
  try {
    connection = await resolveConnectionForApplication(applicationId);
    if (connection.provider !== "S3_COMPATIBLE") {
      return { ok: false, message: "The connected storage for this application is not S3-compatible." };
    }
    const creds = JSON.parse(decryptSecret(connection.encryptedCredentials)) as S3Credentials;
    const objectKey = `${app.slug}/${Date.now()}-${filename}`;
    const { uploadId, partUrls } = await startS3MultipartUpload(creds, objectKey, contentType, partCount);
    return { ok: true, uploadId, partUrls, objectKey, storageConnectionId: connection.id };
  } catch (err) {
    console.error("startS3Upload failed", err);
    return { ok: false, message: storageErrorMessage(err, connection) };
  }
}

export async function s3CredsFor(storageConnectionId: string) {
  const connection = await prisma.storageConnection.findUnique({ where: { id: storageConnectionId } });
  if (!connection || connection.provider !== "S3_COMPATIBLE") {
    throw new Error("S3 storage connection not found.");
  }
  return JSON.parse(decryptSecret(connection.encryptedCredentials)) as S3Credentials;
}

export async function openGDriveUpload(
  applicationId: string,
  filename: string,
  mimeType: string
): Promise<UploadTarget> {
  let connection;
  try {
    connection = await resolveConnectionForApplication(applicationId);
    if (connection.provider !== "GOOGLE_DRIVE") {
      return { ok: false, message: "The connected storage for this application is not Google Drive." };
    }
    const { refreshToken } = JSON.parse(
      decryptSecret(connection.encryptedCredentials)
    ) as { refreshToken: string };
    const uploadUrl = await createResumableUploadSession(refreshToken, filename, mimeType);
    return { ok: true, uploadUrl, storageConnectionId: connection.id };
  } catch (err) {
    console.error("createGDriveUploadSession failed", err);
    return { ok: false, message: storageErrorMessage(err, connection) };
  }
}

type TicketRef = z.infer<typeof TicketRefSchema>;

export type TicketCommentResult = { ticket: string; status: "POSTED" | "FAILED"; error?: string };

export type PublishBuildResult =
  | {
      ok: true;
      appSlug: string;
      id: string;
      shareUrl: string | null;
      /** Only filled when `awaitComments` is set; otherwise comments post in the background. */
      comments: TicketCommentResult[] | null;
    }
  | {
      ok: false;
      errors?: Partial<Record<"version" | "number" | "feature", string[]>>;
      message?: string;
    };

/**
 * Creates the build row for an APK already in storage and comments on the
 * linked issues under the publisher's own GitHub account.
 *
 * - `alwaysShare`: create the public share link even without linked issues.
 * - `awaitComments`: wait for the comments and report them, instead of
 *   letting them run after the response (the web polls comment-status).
 */
export async function publishBuild(
  user: { id: string; name: string },
  data: z.infer<typeof BuildFormSchema>,
  tickets: TicketRef[],
  opts: { alwaysShare?: boolean; awaitComments?: boolean } = {}
): Promise<PublishBuildResult> {
  // Comments go out under the uploader's own GitHub account, never a shared one.
  const githubToken = tickets.length > 0 ? await getGithubToken(user.id) : null;
  if (tickets.length > 0 && !githubToken) {
    return { ok: false, message: NO_GITHUB_TOKEN_MESSAGE };
  }

  const app = await prisma.application.findUnique({ where: { id: data.applicationId } });
  if (!app) return { ok: false, message: "Application not found." };

  const duplicate = await prisma.build.findFirst({
    where: { applicationId: app.id, number: data.number },
    select: { id: true },
  });
  if (duplicate) {
    return {
      ok: false,
      errors: { number: [`Build ${data.number} already exists for this app.`] },
    };
  }

  let build;
  try {
    build = await prisma.build.create({
      data: {
        applicationId: app.id,
        version: data.version,
        number: data.number,
        feature: data.feature,
        releaseNotes: data.releaseNotes || null,
        developerId: user.id,
        status: "PUBLISHED",
        hasInspector: data.hasInspector,
        environment: data.environment,
        storageConnectionId: data.storageConnectionId,
        storageObjectKey: data.storageObjectKey,
        apkFileName: data.apkFileName,
        apkSizeBytes: BigInt(data.apkSizeBytes),
        tickets: tickets.length > 0
          ? {
              create: tickets.map((t) => ({
                repo: t.repo,
                number: t.number,
                title: t.title,
                htmlUrl: t.htmlUrl,
              })),
            }
          : undefined,
      },
    });
  } catch (err) {
    // Lost a race with another publish of the same number (unique constraint).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false,
        errors: { number: [`Build ${data.number} already exists for this app.`] },
      };
    }
    throw err;
  }

  await prisma.storageConnection.update({
    where: { id: data.storageConnectionId },
    data: { usedBytesApprox: { increment: BigInt(data.apkSizeBytes) } },
  });

  if (!githubToken && !opts.alwaysShare) {
    return { ok: true, appSlug: app.slug, id: build.id, shareUrl: null, comments: null };
  }

  // The comment must link the public /share/[token] page, not the authed
  // build page — Bisdev/reviewers on the ticket don't have BuildApp accounts.
  const shareToken = randomBytes(18).toString("base64url");
  await prisma.build.update({
    where: { id: build.id },
    data: { shareToken },
  });
  const shareUrl = absoluteUrl(`/share/${shareToken}`);

  if (!githubToken) {
    return { ok: true, appSlug: app.slug, id: build.id, shareUrl, comments: null };
  }

  const commentArgs = {
    token: githubToken,
    appName: app.name,
    shareUrl,
    buildNumber: build.number,
    version: data.version,
    feature: data.feature,
    developerName: user.name,
    apkSizeBytes: data.apkSizeBytes,
  };
  const buildId = build.id;
  const posting = Promise.all(
    tickets.map(async (t): Promise<TicketCommentResult> => {
      const ref = `${t.repo}#${t.number}`;
      const where = { buildId_repo_number: { buildId, repo: t.repo, number: t.number } };
      try {
        await postBuildComment({ repo: t.repo, issueNumber: t.number, ...commentArgs });
        await prisma.buildTicket.update({ where, data: { commentStatus: "POSTED" } });
        return { ticket: ref, status: "POSTED" };
      } catch (err) {
        const error = err instanceof Error ? err.message : "Unknown error";
        await prisma.buildTicket.update({
          where,
          data: { commentStatus: "FAILED", commentError: error },
        }).catch(() => {});
        return { ticket: ref, status: "FAILED", error };
      }
    })
  );

  if (!opts.awaitComments) {
    // Intentionally not awaited — runs after response is returned
    posting.catch(() => {});
    return { ok: true, appSlug: app.slug, id: build.id, shareUrl, comments: null };
  }
  return { ok: true, appSlug: app.slug, id: build.id, shareUrl, comments: await posting };
}
