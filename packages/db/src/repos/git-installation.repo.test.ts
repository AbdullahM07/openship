import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import type { Database } from "../client";
import { createGitInstallationRepo } from "./git-installation.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

describe("gitInstallation workspace boundary", () => {
  let repo: ReturnType<typeof createGitInstallationRepo>;
  let db: Database;

  beforeAll(async () => {
    const client = new PGlite("memory://");
    db = drizzle(client, { schema }) as Database;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await client.exec("SET session_replication_role = replica;");
    repo = createGitInstallationRepo(db);
  }, 30_000);

  const row = (organizationId: string, userId: string, installationId: number) => ({
    userId,
    organizationId,
    provider: "github",
    installationId,
    owner: "Acme",
    ownerType: "Organization",
    providerOwnerId: "700",
    isOrg: true,
  });

  it("allows the same GitHub installation to be claimed by two workspaces", async () => {
    await repo.upsert(row("org_one", "user_one", 42));
    await repo.upsert(row("org_two", "user_one", 42));

    await expect(repo.listByOrganization("org_one")).resolves.toHaveLength(1);
    await expect(repo.listByOrganization("org_two")).resolves.toHaveLength(1);
  });

  it("converges reconnects inside one workspace instead of duplicating rows", async () => {
    await repo.upsert(row("org_reconnect", "user_old", 40));
    await repo.upsert(row("org_reconnect", "user_new", 41));

    const rows = await repo.listByOrganization("org_reconnect");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: "org_reconnect",
      userId: "user_new",
      installationId: 41,
      owner: "acme",
    });
  });

  it("retains but excludes a suspended binding, then restores it on unsuspend", async () => {
    await repo.upsert(row("org_suspend", "user_one", 99));
    await repo.suspendByInstallationIdForProvider(99);

    await expect(repo.listByOrganization("org_suspend")).resolves.toEqual([]);
    await expect(repo.findByInstallationIdForProvider(99)).resolves.toHaveLength(1);

    // installation.unsuspend goes through the normal upsert and clears the flag.
    await repo.upsert(row("org_suspend", "user_one", 99));
    await expect(repo.listByOrganization("org_suspend")).resolves.toHaveLength(1);
  });

  it("atomically claims state and rebinds projects after a GitHub App reinstall", async () => {
    await db.insert(schema.projectGroup).values({
      id: "app_rebind",
      organizationId: "org_rebind",
      name: "Existing app",
      slug: "existing-app",
      gitProvider: "github",
      gitOwner: "Acme",
      gitRepo: "site",
      installationId: 40,
    });
    await db.insert(schema.project).values({
      id: "prj_rebind",
      organizationId: "org_rebind",
      groupId: "app_rebind",
      name: "Existing app",
      slug: "existing-app",
      environmentSlug: "production",
      gitProvider: "github",
      gitOwner: "ACME",
      gitRepo: "site",
      installationId: 40,
      webhookId: 77,
      webhookSecret: "encrypted-old-secret",
    });

    await db.insert(schema.githubInstallState).values({
      id: "gis_rebind",
      state: "nonce_rebind",
      userId: "user_rebind",
      organizationId: "org_rebind",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(repo.claimWithState("nonce_rebind", row(
      "org_rebind",
      "user_rebind",
      99,
    ))).resolves.toMatchObject({ installationId: 99, owner: "acme" });

    await expect(db.query.project.findFirst({
      where: (table, { eq }) => eq(table.id, "prj_rebind"),
    })).resolves.toMatchObject({
      installationId: 99,
      webhookId: null,
      webhookSecret: null,
    });
    await expect(db.query.projectGroup.findFirst({
      where: (table, { eq }) => eq(table.id, "app_rebind"),
    })).resolves.toMatchObject({ installationId: 99 });
    await expect(db.query.githubInstallState.findFirst({
      where: (table, { eq }) => eq(table.state, "nonce_rebind"),
    })).resolves.toBeUndefined();
    await expect(repo.claimWithState("nonce_rebind", row(
      "org_rebind",
      "user_rebind",
      100,
    ))).resolves.toBeNull();
  });
});
