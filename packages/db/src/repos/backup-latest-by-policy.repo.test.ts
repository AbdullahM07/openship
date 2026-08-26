import { beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import type { Database } from "../client";
import {
  createBackupPolicyRepo,
  createBackupRunRepo,
  type BackupPolicyRepo,
  type BackupRunRepo,
} from "./backup.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

interface TestRepos {
  db: Database;
  policy: BackupPolicyRepo;
  run: BackupRunRepo;
}

async function freshRepos() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await client.exec("SET session_replication_role = replica;");

  await db.insert(schema.organization).values({
    id: "org1",
    name: "Org",
    slug: "org",
  });

  await db.insert(schema.project).values({
    id: "p1",
    organizationId: "org1",
    groupId: "g1",
    name: "app",
    slug: "app",
  });

  await db.insert(schema.backupDestination).values({
    id: "dest1",
    organizationId: "org1",
    name: "Remote NAS",
    kind: "openship_server",
  });

  await db.insert(schema.backupPolicy).values({
    id: "pol1",
    projectId: "p1",
    destinationId: "dest1",
    sourceKind: "service",
    payloadKind: "auto",
  });

  return {
    db,
    policy: createBackupPolicyRepo(db),
    run: createBackupRunRepo(db),
  };
}

describe("repos.backupRun.latestByPolicy", () => {
  let repos: {
    db: Database;
    policy: BackupPolicyRepo;
    run: BackupRunRepo;
  };

  beforeEach(async () => {
    repos = await freshRepos();
  }, 30_000);
  it("returns undefined when policy has no runs", async () => {
    const res = await repos.run.latestByPolicy("pol1");
    expect(res).toBeUndefined();
  });

  it("returns single run metrics for a single-service run", async () => {
    const started = new Date("2026-08-26T10:00:00Z");
    const finished = new Date("2026-08-26T10:01:00Z");

    await repos.db.insert(schema.backupRun).values({
      id: "run-single",
      policyId: "pol1",
      destinationId: "dest1",
      projectId: "p1",
      serviceId: "svc1",
      organizationId: "org1",
      status: "succeeded",
      triggeredBy: "manual",
      startedAt: started,
      finishedAt: finished,
      bytesTransferred: 50_000,
    });

    const res = await repos.run.latestByPolicy("pol1");
    expect(res).toBeDefined();
    expect(res?.id).toBe("run-single");
    expect(res?.status).toBe("succeeded");
    expect(res?.startedAt.toISOString()).toBe(started.toISOString());
    expect(res?.finishedAt?.toISOString()).toBe(finished.toISOString());
    expect(res?.bytesTransferred).toBe(50_000);
  });

  it("aggregates multi-service project runs within the same batch", async () => {
    const baseTime = new Date("2026-08-26T11:32:08.000Z");

    // 5 concurrent child runs from the same policy trigger (e.g. postgres, redis, edge, api, dashboard)
    await repos.db.insert(schema.backupRun).values([
      {
        id: "run-api",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-api",
        organizationId: "org1",
        status: "failed",
        triggeredBy: "cron",
        startedAt: new Date(baseTime.getTime() + 10),
        finishedAt: new Date(baseTime.getTime() + 8000),
        bytesTransferred: 0,
      },
      {
        id: "run-dashboard",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-dashboard",
        organizationId: "org1",
        status: "failed",
        triggeredBy: "cron",
        startedAt: new Date(baseTime.getTime() + 20),
        finishedAt: new Date(baseTime.getTime() + 2500),
        bytesTransferred: 0,
      },
      {
        id: "run-edge",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-edge",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(baseTime.getTime() + 30),
        finishedAt: new Date(baseTime.getTime() + 18000),
        bytesTransferred: 26_988,
      },
      {
        id: "run-postgres",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-postgres",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(baseTime.getTime() + 40),
        finishedAt: new Date(baseTime.getTime() + 17000),
        bytesTransferred: 31_059_009,
      },
      {
        id: "run-redis",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-redis",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(baseTime.getTime() + 50),
        finishedAt: new Date(baseTime.getTime() + 24000),
        bytesTransferred: 124_923,
      },
    ]);

    const res = await repos.run.latestByPolicy("pol1");
    expect(res).toBeDefined();
    // Sum of transferred bytes: 26_988 + 31_059_009 + 124_923 = 31_210_920 (~29.8 MB)
    expect(res?.bytesTransferred).toBe(31_210_920);
    // Since some runs failed, overall batch status is failed
    expect(res?.status).toBe("failed");
    expect(res?.startedAt.toISOString()).toBe(new Date(baseTime.getTime() + 10).toISOString());
    expect(res?.finishedAt?.toISOString()).toBe(new Date(baseTime.getTime() + 24000).toISOString());
  });

  it("reports succeeded status when all child runs in a batch succeed", async () => {
    const baseTime = new Date("2026-08-26T12:00:00.000Z");

    await repos.db.insert(schema.backupRun).values([
      {
        id: "run-db",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-db",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "manual",
        startedAt: new Date(baseTime.getTime() + 10),
        finishedAt: new Date(baseTime.getTime() + 5000),
        bytesTransferred: 10_000_000,
      },
      {
        id: "run-cache",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-cache",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "manual",
        startedAt: new Date(baseTime.getTime() + 20),
        finishedAt: new Date(baseTime.getTime() + 2000),
        bytesTransferred: 500_000,
      },
    ]);

    const res = await repos.run.latestByPolicy("pol1");
    expect(res).toBeDefined();
    expect(res?.status).toBe("succeeded");
    expect(res?.bytesTransferred).toBe(10_500_000);
  });

  it("reports in-flight status and null finishedAt when a batch child is running", async () => {
    const baseTime = new Date("2026-08-26T12:30:00.000Z");

    await repos.db.insert(schema.backupRun).values([
      {
        id: "run-db",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-db",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "manual",
        startedAt: new Date(baseTime.getTime() + 10),
        finishedAt: new Date(baseTime.getTime() + 5000),
        bytesTransferred: 10_000_000,
      },
      {
        id: "run-uploading",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-uploading",
        organizationId: "org1",
        status: "uploading",
        triggeredBy: "manual",
        startedAt: new Date(baseTime.getTime() + 20),
        finishedAt: null,
        bytesTransferred: 2_000_000,
      },
    ]);

    const res = await repos.run.latestByPolicy("pol1");
    expect(res).toBeDefined();
    expect(res?.status).toBe("uploading");
    expect(res?.finishedAt).toBeNull();
    expect(res?.bytesTransferred).toBe(12_000_000);
  });

  it("isolates latest batch from historical older runs", async () => {
    const oldTime = new Date("2026-08-20T03:00:00.000Z");
    const newTime = new Date("2026-08-26T03:00:00.000Z");

    // Old batch from 6 days ago
    await repos.db.insert(schema.backupRun).values([
      {
        id: "old-run-1",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-1",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(oldTime.getTime() + 10),
        finishedAt: new Date(oldTime.getTime() + 5000),
        bytesTransferred: 100_000,
      },
      {
        id: "old-run-2",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-2",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(oldTime.getTime() + 20),
        finishedAt: new Date(oldTime.getTime() + 5000),
        bytesTransferred: 200_000,
      },
    ]);

    // New batch from today
    await repos.db.insert(schema.backupRun).values([
      {
        id: "new-run-1",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-1",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(newTime.getTime() + 10),
        finishedAt: new Date(newTime.getTime() + 5000),
        bytesTransferred: 500_000,
      },
      {
        id: "new-run-2",
        policyId: "pol1",
        destinationId: "dest1",
        projectId: "p1",
        serviceId: "svc-2",
        organizationId: "org1",
        status: "succeeded",
        triggeredBy: "cron",
        startedAt: new Date(newTime.getTime() + 20),
        finishedAt: new Date(newTime.getTime() + 5000),
        bytesTransferred: 700_000,
      },
    ]);

    const res = await repos.run.latestByPolicy("pol1");
    expect(res).toBeDefined();
    // Only today's runs should be included (500_000 + 700_000 = 1_200_000), not old 300_000
    expect(res?.bytesTransferred).toBe(1_200_000);
    expect(res?.startedAt.toISOString()).toBe(new Date(newTime.getTime() + 10).toISOString());
  });
});
