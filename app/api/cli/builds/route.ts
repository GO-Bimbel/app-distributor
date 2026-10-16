import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import { prisma } from "@/lib/db";
import { requireApiPublisher } from "@/lib/apiAuth";
import { publishBuild } from "@/lib/buildPublish";
import { GITHUB_ORG, searchIssues } from "@/lib/github";
import { getGithubToken, NO_GITHUB_TOKEN_MESSAGE } from "@/lib/githubToken";
import { absoluteUrl } from "@/lib/url";
import { BuildFormSchema } from "@/app/lib/definitions";

const PublishSchema = z.object({
  app: z.string().min(1),
  version: z.string(),
  number: z.string(),
  feature: z.string().optional(),
  releaseNotes: z.string().optional(),
  environment: z.enum(["PRODUCTION", "STAGING"]),
  hasInspector: z.boolean().optional(),
  storageConnectionId: z.string(),
  storageObjectKey: z.string(),
  apkFileName: z.string(),
  apkSizeBytes: z.number().int().positive(),
  /** `repo#123`, `GO-Bimbel/repo#123` or an issue URL. */
  tickets: z.array(z.string()).optional(),
});

const TICKET_RE = /^(?:https:\/\/github\.com\/)?(?:([\w.-]+)\/)?([\w.-]+)(?:#|\/issues\/)(\d+)\/?$/;

function parseTicketRef(ref: string) {
  const m = TICKET_RE.exec(ref.trim());
  if (!m) return null;
  const [, owner, repo, num] = m;
  if (owner && owner.toLowerCase() !== GITHUB_ORG.toLowerCase()) return null;
  return { repo, number: Number(num) };
}

/** Publishes a build for an APK the CLI already put in storage. */
export async function POST(req: Request) {
  const auth = await requireApiPublisher(req);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const parsed = PublishSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", fields: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const app = await prisma.application.findUnique({ where: { slug: body.app }, select: { id: true } });
  if (!app) return NextResponse.json({ error: `Application "${body.app}" not found.` }, { status: 404 });

  // Look each issue up with the publisher's own token: confirms it exists and
  // gives the title/link the build page and comment show.
  const tickets = [];
  const refs = [...new Set(body.tickets ?? [])];
  if (refs.length > 0) {
    const token = await getGithubToken(user.id);
    if (!token) return NextResponse.json({ error: NO_GITHUB_TOKEN_MESSAGE }, { status: 409 });
    for (const ref of refs) {
      const t = parseTicketRef(ref);
      if (!t) {
        return NextResponse.json(
          { error: `Can't read issue "${ref}". Use repo#123 (in ${GITHUB_ORG}) or an issue URL.` },
          { status: 400 }
        );
      }
      let issue;
      try {
        [issue] = await searchIssues(token, t.repo, String(t.number));
      } catch (err) {
        return NextResponse.json(
          { error: `GitHub lookup for ${t.repo}#${t.number} failed: ${err instanceof Error ? err.message : err}` },
          { status: 502 }
        );
      }
      if (!issue) {
        return NextResponse.json({ error: `Issue ${GITHUB_ORG}/${t.repo}#${t.number} not found.` }, { status: 404 });
      }
      tickets.push({ repo: issue.repo, number: issue.number, title: issue.title, htmlUrl: issue.htmlUrl });
    }
  }

  const validated = BuildFormSchema.safeParse({
    applicationId: app.id,
    version: body.version,
    number: body.number,
    // Same default as the web form: the first linked issue's title.
    feature: body.feature?.trim() || tickets[0]?.title || "",
    tickets,
    releaseNotes: body.releaseNotes || undefined,
    storageConnectionId: body.storageConnectionId,
    storageObjectKey: body.storageObjectKey,
    apkFileName: body.apkFileName,
    apkSizeBytes: body.apkSizeBytes,
    hasInspector: String(body.hasInspector ?? false),
    environment: body.environment,
  });
  if (!validated.success) {
    return NextResponse.json(
      { error: "Invalid build.", fields: validated.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const result = await publishBuild(user, validated.data, tickets, {
    alwaysShare: true,
    awaitComments: true,
  });
  if (!result.ok) {
    const status = result.errors?.number ? 409 : 400;
    return NextResponse.json({ error: result.message ?? "Invalid build.", fields: result.errors }, { status });
  }

  revalidatePath(`/apps/${result.appSlug}`);
  revalidatePath("/");
  return NextResponse.json({
    id: result.id,
    url: absoluteUrl(`/apps/${result.appSlug}/builds/${result.id}`),
    shareUrl: result.shareUrl,
    comments: result.comments,
  });
}
