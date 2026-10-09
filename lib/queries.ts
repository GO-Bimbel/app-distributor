import "server-only";
import { Prisma, type Environment } from "@prisma/client";
import { prisma } from "./db";

/**
 * Highest version first, compared part by part as numbers (1.2.10 > 1.2.9),
 * then highest build number, then newest upload. `version` and `number` are
 * free-text columns, so their digits are pulled out rather than cast.
 */
const BY_VERSION_DESC = Prisma.sql`
  ARRAY(
    SELECT m.v[1]::numeric
    FROM regexp_matches("version", '([0-9]+)', 'g') WITH ORDINALITY AS m(v, i)
    ORDER BY m.i
  ) DESC,
  NULLIF(regexp_replace("number", '[^0-9]', '', 'g'), '')::numeric DESC NULLS LAST,
  "createdAt" DESC`;

/** Ids of an app's builds in version order, optionally within one version. */
async function buildIdsByVersion(
  applicationId: string,
  opts: { limit?: number; version?: string; excludeId?: string } = {}
) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Build"
    WHERE "applicationId" = ${applicationId}
      ${opts.version !== undefined ? Prisma.sql`AND "version" = ${opts.version}` : Prisma.empty}
      ${opts.excludeId ? Prisma.sql`AND "id" <> ${opts.excludeId}` : Prisma.empty}
    ORDER BY ${BY_VERSION_DESC}
    ${opts.limit ? Prisma.sql`LIMIT ${opts.limit}` : Prisma.empty}`;
  return rows.map((r) => r.id);
}

/** Loads builds by id and puts them back in the order the ids came in. */
function inIdOrder<T extends { id: string }>(ids: string[], rows: T[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => !!r);
}

export async function listApplications() {
  const [apps, sizeByApp] = await Promise.all([
    prisma.application.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { builds: true } } },
    }),
    prisma.build.groupBy({
      by: ["applicationId"],
      _sum: { apkSizeBytes: true },
    }),
  ]);
  const sizeMap = new Map(
    sizeByApp.map((s) => [s.applicationId, s._sum.apkSizeBytes ?? BigInt(0)])
  );

  const latestRows = await prisma.$queryRaw<
    { applicationId: string; number: string; version: string; environment: Environment }[]
  >`
    SELECT DISTINCT ON ("applicationId") "applicationId", "number", "version", "environment"
    FROM "Build"
    ORDER BY "applicationId", ${BY_VERSION_DESC}`;
  const latestMap = new Map(latestRows.map(({ applicationId, ...b }) => [applicationId, b]));

  return apps.map((app) => ({
    ...app,
    buildCount: app._count.builds,
    usedBytes: sizeMap.get(app.id) ?? BigInt(0),
    latest: latestMap.get(app.id) ?? null,
  }));
}

export const BUILD_PAGE_SIZE = 30;

/** App page: the top `limit` builds by version, grouped by version, plus the total. */
export async function getApplicationBySlug(slug: string, limit = BUILD_PAGE_SIZE) {
  const app = await prisma.application.findUnique({
    where: { slug },
    include: { defaultStorage: { select: { name: true, provider: true } } },
  });
  if (!app) return null;

  const [ids, totalBuilds] = await Promise.all([
    buildIdsByVersion(app.id, { limit }),
    prisma.build.count({ where: { applicationId: app.id } }),
  ]);
  const builds = inIdOrder(
    ids,
    await prisma.build.findMany({
      where: { id: { in: ids } },
      include: {
        developer: { select: { name: true } },
        _count: { select: { tickets: true } },
      },
    })
  );

  const groupsByVersion = new Map<string, typeof builds>();
  for (const b of builds) {
    const list = groupsByVersion.get(b.version) ?? [];
    list.push(b);
    groupsByVersion.set(b.version, list);
  }

  return {
    app,
    latest: builds[0] ?? null,
    lastNumber: builds[0]?.number ?? null,
    totalBuilds,
    versionGroups: Array.from(groupsByVersion.entries()).map(
      ([version, groupBuilds]) => ({
        version,
        builds: groupBuilds,
      })
    ),
  };
}

/** Create-build page: only what the form needs — never the full build history. */
export async function getNewBuildContext(slug: string) {
  const app = await prisma.application.findUnique({
    where: { slug },
    include: { defaultStorage: { select: { name: true, provider: true } } },
  });
  if (!app) return null;

  const [[latestId], numbers] = await Promise.all([
    buildIdsByVersion(app.id, { limit: 1 }),
    prisma.build.findMany({ where: { applicationId: app.id }, select: { number: true } }),
  ]);
  const latest = latestId
    ? await prisma.build.findUnique({
        where: { id: latestId },
        select: { version: true, number: true },
      })
    : null;
  return { app, latest, existingNumbers: numbers.map((b) => b.number) };
}

export async function getBuild(slug: string, id: string) {
  const build = await prisma.build.findUnique({
    where: { id },
    include: {
      // defaultStorage: where a Replace APK upload goes.
      application: { include: { defaultStorage: { select: { name: true, provider: true } } } },
      developer: { select: { name: true } },
      tickets: { orderBy: { createdAt: "asc" } },
      updates: { orderBy: { createdAt: "desc" }, include: { uploadedBy: { select: { name: true } } } },
    },
  });
  if (!build || build.application.slug !== slug) return null;

  const siblingIds = await buildIdsByVersion(build.applicationId, {
    version: build.version,
    excludeId: build.id,
  });
  const siblings = inIdOrder(
    siblingIds,
    await prisma.build.findMany({
      where: { id: { in: siblingIds } },
      include: { developer: { select: { name: true } } },
    })
  );

  return { app: build.application, build, siblings };
}

/** Build detail by id alone — for clients (e.g. mobile) that already know the app from a prior list call. */
export async function getBuildById(id: string) {
  const build = await prisma.build.findUnique({
    where: { id },
    include: {
      application: true,
      developer: { select: { name: true } },
      tickets: { orderBy: { createdAt: "asc" } },
      updates: { orderBy: { createdAt: "desc" }, include: { uploadedBy: { select: { name: true } } } },
    },
  });
  if (!build) return null;

  const siblingIds = await buildIdsByVersion(build.applicationId, {
    version: build.version,
    excludeId: build.id,
  });
  const siblings = inIdOrder(
    siblingIds,
    await prisma.build.findMany({
      where: { id: { in: siblingIds } },
      include: { developer: { select: { name: true } } },
    })
  );

  return { app: build.application, build, siblings };
}

export async function getRecentBuilds(limit = 7) {
  return prisma.build.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      developer: { select: { name: true } },
      application: { select: { slug: true, name: true } },
      _count: { select: { tickets: true } },
    },
  });
}

export async function getDashboardStats() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [buildsThisWeek, publishedToday, applicationCount, sizeAgg, openIssues] =
    await Promise.all([
      prisma.build.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.build.count({
        where: { status: "PUBLISHED", createdAt: { gte: startOfToday } },
      }),
      prisma.application.count(),
      prisma.build.aggregate({ _sum: { apkSizeBytes: true } }),
      prisma.$queryRaw<[{ n: number }]>`
        SELECT COUNT(DISTINCT ("repo", "number"))::int AS n FROM "BuildTicket"
      `,
    ]);

  return {
    buildsThisWeek,
    publishedToday,
    applicationCount,
    storageUsedBytes: sizeAgg._sum.apkSizeBytes ?? BigInt(0),
    issuesLinked: openIssues[0].n,
  };
}

export async function listStorageConnections() {
  const connections = await prisma.storageConnection.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      provider: true,
      accountLabel: true,
      isDefault: true,
      usedBytesApprox: true,
      createdAt: true,
      applications: { select: { id: true, name: true } },
    },
  });
  return connections;
}

export async function getApplicationStorageMap() {
  return prisma.application.findMany({
    orderBy: { name: "asc" },
    include: { defaultStorage: { select: { name: true } } },
  });
}
