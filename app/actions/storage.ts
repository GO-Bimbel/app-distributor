"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePublisher } from "@/lib/dal";
import { absoluteUrl } from "@/lib/url";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import {
  listS3Objects,
  startS3MultipartUpload,
  completeS3MultipartUpload,
  abortS3MultipartUpload,
} from "@/lib/storage/s3";
import { postBuildComment, postApkUpdatedComment } from "@/lib/github";
import { getGithubToken, NO_GITHUB_TOKEN_MESSAGE } from "@/lib/githubToken";
import { removeStoredObject } from "@/lib/storage/removeObject";
import { storageErrorMessage } from "@/lib/storage/errors";
import {
  createResumableUploadSession,
  listDistributionFolderFiles,
} from "@/lib/storage/gdrive";
import {
  S3ConnectionSchema,
  BuildFormSchema,
  ReplaceApkSchema,
  TicketRefSchema,
  type FormState,
} from "@/app/lib/definitions";
import type { S3Credentials } from "@/lib/storage/s3";

export async function addS3Connection(
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  await requirePublisher();

  const validated = S3ConnectionSchema.safeParse({
    name: formData.get("name"),
    accessKeyId: formData.get("accessKeyId"),
    secretAccessKey: formData.get("secretAccessKey"),
    region: formData.get("region"),
    bucket: formData.get("bucket"),
    endpoint: formData.get("endpoint") || "",
  });

  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const { name, accessKeyId, secretAccessKey, region, bucket, endpoint } =
    validated.data;

  const creds: S3Credentials = {
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
    endpoint: endpoint || undefined,
  };

  const existingCount = await prisma.storageConnection.count();

  await prisma.storageConnection.create({
    data: {
      name,
      provider: "S3_COMPATIBLE",
      accountLabel: `${bucket} / ${region}`,
      isDefault: existingCount === 0,
      encryptedCredentials: encryptSecret(JSON.stringify(creds)),
    },
  });

  revalidatePath("/storage");
  redirect("/storage");
}

export async function setDefaultConnection(formData: FormData) {
  await requirePublisher();
  const id = String(formData.get("id"));

  await prisma.$transaction([
    prisma.storageConnection.updateMany({
      data: { isDefault: false },
      where: {},
    }),
    prisma.storageConnection.update({
      where: { id },
      data: { isDefault: true },
    }),
  ]);

  revalidatePath("/storage");
}

export async function disconnectConnection(formData: FormData) {
  await requirePublisher();
  const id = String(formData.get("id"));
  await prisma.storageConnection.delete({ where: { id } });
  revalidatePath("/storage");
}

export async function setApplicationStorage(formData: FormData) {
  await requirePublisher();
  const applicationId = String(formData.get("applicationId"));
  const storageConnectionId = String(formData.get("storageConnectionId"));
  await prisma.application.update({
    where: { id: applicationId },
    data: { defaultStorageId: storageConnectionId },
  });
  revalidatePath("/storage");
}

async function resolveConnectionForApplication(applicationId: string) {
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
const MAX_S3_PARTS = 200;

export async function startS3Upload(
  applicationId: string,
  filename: string,
  contentType: string,
  partCount: number
): Promise<S3UploadTarget> {
  await requirePublisher();
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

async function s3CredsFor(storageConnectionId: string) {
  const connection = await prisma.storageConnection.findUnique({ where: { id: storageConnectionId } });
  if (!connection || connection.provider !== "S3_COMPATIBLE") {
    throw new Error("S3 storage connection not found.");
  }
  return JSON.parse(decryptSecret(connection.encryptedCredentials)) as S3Credentials;
}

export async function completeS3Upload(
  storageConnectionId: string,
  objectKey: string,
  uploadId: string,
  partCount: number
): Promise<StorageResult> {
  await requirePublisher();
  return asStorageResult(storageConnectionId, async () => {
    await completeS3MultipartUpload(await s3CredsFor(storageConnectionId), objectKey, uploadId, partCount);
    return {};
  });
}

/** Best effort: frees the parts already stored when an upload is given up. */
export async function abortS3Upload(
  storageConnectionId: string,
  objectKey: string,
  uploadId: string
): Promise<StorageResult> {
  await requirePublisher();
  return asStorageResult(storageConnectionId, async () => {
    await abortS3MultipartUpload(await s3CredsFor(storageConnectionId), objectKey, uploadId);
    return {};
  });
}

export async function createGDriveUploadSession(
  applicationId: string,
  filename: string,
  mimeType: string
): Promise<UploadTarget> {
  await requirePublisher();
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

export type FinalizeBuildResult =
  | { ok: true; appSlug: string; id: string }
  | {
      ok: false;
      errors?: Partial<Record<"version" | "number" | "feature", string[]>>;
      message?: string;
    };

export async function finalizeBuild(formData: FormData): Promise<FinalizeBuildResult> {
  const user = await requirePublisher();

  const rawTickets = formData.get("tickets");
  let parsedTickets: Array<{ repo: string; number: number; title: string; htmlUrl: string }> = [];
  if (rawTickets) {
    try {
      const arr = JSON.parse(String(rawTickets));
      parsedTickets = TicketRefSchema.array().parse(arr);
    } catch {
      return { ok: false, message: "Invalid ticket data." };
    }
  }

  const validated = BuildFormSchema.safeParse({
    applicationId: formData.get("applicationId"),
    version: formData.get("version"),
    number: formData.get("number"),
    feature: formData.get("feature"),
    tickets: parsedTickets,
    releaseNotes: formData.get("releaseNotes") || undefined,
    storageConnectionId: formData.get("storageConnectionId"),
    storageObjectKey: formData.get("storageObjectKey"),
    apkFileName: formData.get("apkFileName"),
    apkSizeBytes: formData.get("apkSizeBytes"),
    hasInspector: formData.get("hasInspector"),
    environment: formData.get("environment"),
  });

  if (!validated.success) {
    return { ok: false, errors: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  // Comments go out under the uploader's own GitHub account, never a shared one.
  const githubToken = parsedTickets.length > 0 ? await getGithubToken(user.id) : null;
  if (parsedTickets.length > 0 && !githubToken) {
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
        tickets: parsedTickets.length > 0
          ? {
              create: parsedTickets.map((t) => ({
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

  // Post comment to all linked GitHub issues in the background — update commentStatus per ticket
  if (githubToken) {
    // The comment must link the public /share/[token] page, not the authed
    // build page — Bisdev/reviewers on the ticket don't have BuildApp accounts.
    const shareToken = randomBytes(18).toString("base64url");
    await prisma.build.update({
      where: { id: build.id },
      data: { shareToken },
    });
    const shareUrl = absoluteUrl(`/share/${shareToken}`);

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
    // Intentionally not awaited — runs after response is returned
    Promise.allSettled(
      parsedTickets.map(async (t) => {
        const ticket = await prisma.buildTicket.findUnique({
          where: { buildId_repo_number: { buildId: build.id, repo: t.repo, number: t.number } },
        });
        if (!ticket) return;
        try {
          await postBuildComment({ repo: t.repo, issueNumber: t.number, ...commentArgs });
          await prisma.buildTicket.update({
            where: { id: ticket.id },
            data: { commentStatus: "POSTED" },
          });
        } catch (err) {
          await prisma.buildTicket.update({
            where: { id: ticket.id },
            data: {
              commentStatus: "FAILED",
              commentError: err instanceof Error ? err.message : "Unknown error",
            },
          });
        }
      })
    ).catch(() => {});
  }

  revalidatePath(`/apps/${app.slug}`);
  revalidatePath("/");
  return { ok: true, appSlug: app.slug, id: build.id };
}

export type ReplaceApkResult =
  | {
      ok: true;
      /** Outcome of the "APK updated" comments on linked issues; null when none were sent. */
      comments: { posted: number; failed: string[]; skipped?: string } | null;
    }
  | { ok: false; message: string };

/**
 * Swaps the APK behind an existing build. The build keeps its id, number and
 * share token, so every link already handed out serves the new file. Only the
 * developer who published the build may do this.
 */
export async function replaceBuildApk(formData: FormData): Promise<ReplaceApkResult> {
  const user = await requirePublisher();

  const validated = ReplaceApkSchema.safeParse({
    buildId: formData.get("buildId"),
    note: formData.get("note") || undefined,
    storageConnectionId: formData.get("storageConnectionId"),
    storageObjectKey: formData.get("storageObjectKey"),
    apkFileName: formData.get("apkFileName"),
    apkSizeBytes: formData.get("apkSizeBytes"),
    hasInspector: formData.get("hasInspector"),
  });
  const notifyIssues = formData.get("notifyIssues") === "true";
  if (!validated.success) {
    const first = Object.values(validated.error.flatten().fieldErrors).flat()[0];
    return { ok: false, message: first ?? "Invalid replace request." };
  }
  const data = validated.data;

  const build = await prisma.build.findUnique({
    where: { id: data.buildId },
    include: {
      application: { select: { slug: true, name: true } },
      storageConnection: true,
      tickets: { select: { repo: true, number: true } },
    },
  });
  if (!build) return { ok: false, message: "Build not found." };
  if (build.developerId !== user.id) {
    return { ok: false, message: "Only the developer who uploaded this build can replace its APK." };
  }

  const newSize = BigInt(data.apkSizeBytes);
  await prisma.$transaction(async (tx) => {
    await tx.build.update({
      where: { id: build.id },
      data: {
        storageConnectionId: data.storageConnectionId,
        storageObjectKey: data.storageObjectKey,
        apkFileName: data.apkFileName,
        apkSizeBytes: newSize,
        hasInspector: data.hasInspector,
        status: "PUBLISHED",
      },
    });
    await tx.buildUpdate.create({
      data: {
        buildId: build.id,
        note: data.note || null,
        apkFileName: data.apkFileName,
        apkSizeBytes: newSize,
        previousApkFileName: build.apkFileName,
        uploadedById: user.id,
      },
    });
    if (build.storageConnectionId && build.apkSizeBytes) {
      await tx.storageConnection.update({
        where: { id: build.storageConnectionId },
        data: { usedBytesApprox: { decrement: build.apkSizeBytes } },
      });
      // The counter is approximate — never let it go negative.
      await tx.storageConnection.updateMany({
        where: { id: build.storageConnectionId, usedBytesApprox: { lt: 0 } },
        data: { usedBytesApprox: 0 },
      });
    }
    await tx.storageConnection.update({
      where: { id: data.storageConnectionId },
      data: { usedBytesApprox: { increment: newSize } },
    });
  });

  // Row first, old file second: if removal fails the old APK is merely
  // unlinked and shows up in Storage → Clean up.
  if (build.storageConnection && build.storageObjectKey && build.storageObjectKey !== data.storageObjectKey) {
    try {
      await removeStoredObject(build.storageConnection, build.storageObjectKey);
    } catch (err) {
      console.error(`replaceBuildApk: could not remove old APK for ${build.id}`, err);
    }
  }

  // Awaited (unlike on publish) so the uploader sees right away which issues
  // were told about the new APK. A failed comment never undoes the replace.
  let comments: { posted: number; failed: string[]; skipped?: string } | null = null;
  if (notifyIssues && build.tickets.length > 0) {
    const githubToken = await getGithubToken(user.id);
    if (!githubToken) {
      comments = { posted: 0, failed: [], skipped: NO_GITHUB_TOKEN_MESSAGE };
    } else {
      const results = await Promise.allSettled(
        build.tickets.map((t) =>
          postApkUpdatedComment({
            token: githubToken,
            repo: t.repo,
            issueNumber: t.number,
            appName: build.application.name,
            // A revoked share link stays revoked — the comment then has no link.
            shareUrl: build.shareToken ? absoluteUrl(`/share/${build.shareToken}`) : null,
            buildNumber: build.number,
            version: build.version,
            developerName: user.name,
            apkSizeBytes: data.apkSizeBytes,
            note: data.note || null,
          })
        )
      );
      comments = {
        posted: results.filter((r) => r.status === "fulfilled").length,
        failed: build.tickets
          .filter((_, i) => results[i].status === "rejected")
          .map((t) => `${t.repo}#${t.number}`),
      };
      results.forEach((r) => {
        if (r.status === "rejected") console.error("replaceBuildApk: comment failed", r.reason);
      });
    }
  }

  revalidatePath(`/apps/${build.application.slug}`);
  revalidatePath(`/apps/${build.application.slug}/builds/${build.id}`);
  if (build.shareToken) revalidatePath(`/share/${build.shareToken}`);
  revalidatePath("/storage");
  return { ok: true, comments };
}

export type AddTicketsResult =
  | { ok: true; added: number; posted: number; failed: string[] }
  | { ok: false; message: string };

/**
 * Links more GitHub issues to an existing build and posts the usual build
 * comment on each newly linked one. Only the build's developer may do this.
 */
export async function addBuildTickets(
  buildId: string,
  tickets: Array<{ repo: string; number: number; title: string; htmlUrl: string }>
): Promise<AddTicketsResult> {
  const user = await requirePublisher();

  const parsed = TicketRefSchema.array().min(1).safeParse(tickets);
  if (!parsed.success) return { ok: false, message: "Pick at least one issue." };

  const build = await prisma.build.findUnique({
    where: { id: buildId },
    include: {
      application: { select: { slug: true, name: true } },
      tickets: { select: { repo: true, number: true } },
    },
  });
  if (!build) return { ok: false, message: "Build not found." };
  if (build.developerId !== user.id) {
    return { ok: false, message: "Only the developer who uploaded this build can link issues to it." };
  }

  const linked = new Set(build.tickets.map((t) => `${t.repo}#${t.number}`));
  const fresh = parsed.data.filter((t) => !linked.has(`${t.repo}#${t.number}`));
  if (fresh.length === 0) return { ok: false, message: "Those issues are already linked." };

  const githubToken = await getGithubToken(user.id);
  if (!githubToken) return { ok: false, message: NO_GITHUB_TOKEN_MESSAGE };

  // The comment links the public share page. Builds published without issues
  // may not have one yet.
  let shareToken = build.shareToken;
  if (!shareToken) {
    shareToken = randomBytes(18).toString("base64url");
    await prisma.build.update({ where: { id: build.id }, data: { shareToken } });
  }
  const shareUrl = absoluteUrl(`/share/${shareToken}`);

  await prisma.buildTicket.createMany({
    data: fresh.map((t) => ({
      buildId: build.id,
      repo: t.repo,
      number: t.number,
      title: t.title,
      htmlUrl: t.htmlUrl,
    })),
    skipDuplicates: true,
  });

  // Awaited and settled here: the comment-status poller times PENDING tickets
  // out against the build's createdAt, which on an old build is long past.
  const commentArgs = {
    token: githubToken,
    appName: build.application.name,
    shareUrl,
    buildNumber: build.number,
    version: build.version,
    feature: build.feature,
    developerName: user.name,
    apkSizeBytes: Number(build.apkSizeBytes ?? 0),
  };
  const results = await Promise.allSettled(
    fresh.map((t) => postBuildComment({ repo: t.repo, issueNumber: t.number, ...commentArgs }))
  );
  await Promise.all(
    fresh.map((t, i) => {
      const r = results[i];
      return prisma.buildTicket.update({
        where: { buildId_repo_number: { buildId: build.id, repo: t.repo, number: t.number } },
        data:
          r.status === "fulfilled"
            ? { commentStatus: "POSTED", commentError: null }
            : {
                commentStatus: "FAILED",
                commentError: r.reason instanceof Error ? r.reason.message : "Unknown error",
              },
      });
    })
  );

  revalidatePath(`/apps/${build.application.slug}`);
  revalidatePath(`/apps/${build.application.slug}/builds/${build.id}`);
  revalidatePath(`/share/${shareToken}`);
  return {
    ok: true,
    added: fresh.length,
    posted: results.filter((r) => r.status === "fulfilled").length,
    failed: fresh.filter((_, i) => results[i].status === "rejected").map((t) => `${t.repo}#${t.number}`),
  };
}

export type UnlinkedFile = {
  key: string;
  name: string;
  size: number;
  createdAt: string | null;
  /** Trashed on Drive (recoverable) vs. permanently deleted (S3 has no trash). */
  recoverable: boolean;
};

/** Lists files sitting in a connection's storage that no Build references —
 *  leftovers from uploads that failed, or were abandoned, after the file
 *  landed in storage but before the build record was created. */
export type StorageResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Returned rather than thrown, so the real reason reaches the UI in production. */
async function asStorageResult<T extends object>(
  storageConnectionId: string,
  run: () => Promise<T>
): Promise<StorageResult<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (err) {
    console.error(`storage action failed for connection ${storageConnectionId}`, err);
    const connection = await prisma.storageConnection.findUnique({
      where: { id: storageConnectionId },
      select: { accountLabel: true },
    });
    return { ok: false, message: storageErrorMessage(err, connection) };
  }
}

export async function findUnlinkedFiles(
  storageConnectionId: string
): Promise<StorageResult<{ files: UnlinkedFile[] }>> {
  await requirePublisher();
  return asStorageResult(storageConnectionId, async () => ({
    files: await scanUnlinkedFiles(storageConnectionId),
  }));
}

export async function deleteUnlinkedFile(
  storageConnectionId: string,
  fileKey: string
): Promise<StorageResult> {
  await requirePublisher();
  return asStorageResult(storageConnectionId, async () => {
    await removeUnlinkedFile(storageConnectionId, fileKey);
    return {};
  });
}

async function scanUnlinkedFiles(storageConnectionId: string): Promise<UnlinkedFile[]> {
  const connection = await prisma.storageConnection.findUnique({
    where: { id: storageConnectionId },
  });
  if (!connection) throw new Error("Storage connection not found");

  const linkedKeys = new Set(
    (
      await prisma.build.findMany({
        where: { storageConnectionId },
        select: { storageObjectKey: true },
      })
    )
      .map((b) => b.storageObjectKey)
      .filter((k): k is string => !!k)
  );

  if (connection.provider === "GOOGLE_DRIVE") {
    const { refreshToken } = JSON.parse(
      decryptSecret(connection.encryptedCredentials)
    ) as { refreshToken: string };
    const files = await listDistributionFolderFiles(refreshToken);
    return files
      .filter((f) => !linkedKeys.has(f.id))
      .map((f) => ({
        key: f.id,
        name: f.name,
        size: f.size,
        createdAt: f.createdTime,
        recoverable: true,
      }));
  }

  const creds = JSON.parse(
    decryptSecret(connection.encryptedCredentials)
  ) as S3Credentials;
  const objects = await listS3Objects(creds);
  return objects
    .filter((o) => !linkedKeys.has(o.key))
    .map((o) => ({
      key: o.key,
      name: o.key,
      size: o.size,
      createdAt: o.lastModified ? o.lastModified.toISOString() : null,
      recoverable: false,
    }));
}

async function removeUnlinkedFile(storageConnectionId: string, fileKey: string) {
  const connection = await prisma.storageConnection.findUnique({
    where: { id: storageConnectionId },
  });
  if (!connection) throw new Error("Storage connection not found");

  // Re-check right before deleting — a build may have been published with
  // this exact key in the moments since the list was fetched.
  const stillLinked = await prisma.build.findFirst({
    where: { storageConnectionId, storageObjectKey: fileKey },
  });
  if (stillLinked) {
    throw new Error("This file is linked to a build — refusing to delete it.");
  }

  await removeStoredObject(connection, fileKey);

  revalidatePath("/storage");
}
