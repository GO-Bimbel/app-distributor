"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { requirePublisher } from "@/lib/dal";
import { absoluteUrl } from "@/lib/url";
import { removeStoredObject } from "@/lib/storage/removeObject";
import { ApplicationSchema, type FormState } from "@/app/lib/definitions";

export async function addApplication(
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  await requirePublisher();

  const validated = ApplicationSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    platform: formData.get("platform"),
    initials: formData.get("initials"),
  });

  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const { name, slug, platform, initials } = validated.data;

  const exists = await prisma.application.findUnique({ where: { slug } });
  if (exists) {
    return { errors: { slug: ["Slug already in use."] } };
  }

  await prisma.application.create({
    data: { name, slug, platform, initials },
  });

  revalidatePath("/storage");
  revalidatePath("/apps");
  redirect("/storage");
}

export async function updateApplication(
  _state: FormState,
  formData: FormData
): Promise<FormState> {
  await requirePublisher();

  const id = String(formData.get("id"));

  const validated = ApplicationSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    platform: formData.get("platform"),
    initials: formData.get("initials"),
  });

  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const { name, slug, platform, initials } = validated.data;

  const conflict = await prisma.application.findFirst({
    where: { slug, NOT: { id } },
  });
  if (conflict) {
    return { errors: { slug: ["Slug already in use by another app."] } };
  }

  await prisma.application.update({
    where: { id },
    data: { name, slug, platform, initials },
  });

  revalidatePath("/storage");
  revalidatePath("/apps");
  redirect("/storage");
}

export type DeleteApplicationState = { message?: string } | undefined;

export async function deleteApplication(
  _prev: DeleteApplicationState,
  formData: FormData
): Promise<DeleteApplicationState> {
  await requirePublisher();
  const id = String(formData.get("id"));

  // Builds reference the app with ON DELETE RESTRICT; say so instead of
  // letting the delete throw a bare constraint error.
  const buildCount = await prisma.build.count({ where: { applicationId: id } });
  if (buildCount > 0) {
    return {
      message: `This app still has ${buildCount} build${buildCount === 1 ? "" : "s"}. Delete them first.`,
    };
  }

  try {
    await prisma.application.delete({ where: { id } });
  } catch (err) {
    // A build published between the count and the delete trips the constraint.
    console.error(`deleteApplication failed for ${id}`, err);
    return { message: "Couldn't delete this app — it may have just gained a build. Try again." };
  }
  revalidatePath("/storage");
  revalidatePath("/apps");
}

export async function deleteBuild(formData: FormData) {
  await requirePublisher();
  const id = String(formData.get("id"));
  const build = await prisma.build.findUnique({
    where: { id },
    include: { application: true, storageConnection: true },
  });
  if (!build) throw new Error("Build not found");

  // Row first, file second: if the file removal fails, the APK is merely
  // unlinked and shows up in Storage → Clean up, instead of a build that
  // points at a missing file.
  await prisma.$transaction(async (tx) => {
    await tx.build.delete({ where: { id } });
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
  });

  if (build.storageConnection && build.storageObjectKey) {
    try {
      await removeStoredObject(build.storageConnection, build.storageObjectKey);
    } catch (err) {
      console.error(`deleteBuild: could not remove stored APK for ${id}`, err);
    }
  }

  revalidatePath(`/apps/${build.application.slug}`);
  revalidatePath("/storage");
  revalidatePath("/");
  redirect(`/apps/${build.application.slug}`);
}

export async function generateShareToken(buildId: string): Promise<string> {
  await requirePublisher();
  const existing = await prisma.build.findUnique({
    where: { id: buildId },
    select: { shareToken: true },
  });
  if (!existing) throw new Error("Build not found");
  if (existing.shareToken) return absoluteUrl(`/share/${existing.shareToken}`);

  const token = randomBytes(18).toString("base64url");
  await prisma.build.update({
    where: { id: buildId },
    data: { shareToken: token },
  });
  revalidatePath(`/share/${token}`);
  return absoluteUrl(`/share/${token}`);
}

/** Kills the public link; a later share creates a new, different token. */
export async function revokeShareToken(buildId: string): Promise<void> {
  await requirePublisher();
  const build = await prisma.build.update({
    where: { id: buildId },
    data: { shareToken: null },
    select: { application: { select: { slug: true } } },
  });
  revalidatePath(`/apps/${build.application.slug}/builds/${buildId}`);
}
