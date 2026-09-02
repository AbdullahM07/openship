import { eq, and, isNull, gt } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Database } from "../client";
import { gitInstallation, githubInstallState } from "../schema";
import { rebindGitHubInstallationRows } from "./project.repo";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GitInstallation = typeof gitInstallation.$inferSelect;
export type NewGitInstallation = typeof gitInstallation.$inferInsert;

async function upsertInstallation(
  db: Database,
  data: Omit<NewGitInstallation, "id">,
): Promise<GitInstallation> {
  const id = randomUUID();
  const row = { id, ...data, owner: data.owner.toLowerCase() };
  const now = new Date();
  const [returned] = await db
    .insert(gitInstallation)
    .values(row)
    .onConflictDoUpdate({
      target: [
        gitInstallation.provider,
        gitInstallation.owner,
        gitInstallation.organizationId,
      ],
      set: {
        userId: data.userId,
        installationId: data.installationId,
        organizationId: data.organizationId,
        ownerType: data.ownerType,
        providerUserId: data.providerUserId ?? null,
        providerOwnerId: data.providerOwnerId ?? null,
        isOrg: data.isOrg ?? false,
        suspendedAt: data.suspendedAt ?? null,
        updatedAt: now,
      },
    })
    .returning();
  return returned ?? { ...row, createdAt: now, updatedAt: now };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGitInstallationRepo(db: Database) {
  return {
    /** Find installation by user + owner */
    async findByOwner(userId: string, owner: string) {
      return db.query.gitInstallation.findFirst({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.owner, owner.toLowerCase()),
          isNull(gitInstallation.suspendedAt),
        ),
      });
    },

    /**
     * Find installation by organization + owner.
     *
     * Multi-user/org scoping path: a single GitHub App installation may be
     * accessed by any member of the owning org. Resolution by org is the
     * preferred path for multi-user — `findByOwner(userId, ...)` ties the
     * installation to whichever member happened to install it, which breaks
     * the moment that user leaves the org.
     */
    async findByOrgAndOwner(organizationId: string, owner: string) {
      return db.query.gitInstallation.findFirst({
        where: and(
          eq(gitInstallation.organizationId, organizationId),
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.owner, owner.toLowerCase()),
          isNull(gitInstallation.suspendedAt),
        ),
      });
    },

    /** Find all installations for a user */
    async listByUser(userId: string) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
          isNull(gitInstallation.suspendedAt),
        ),
      });
    },

    /** List installations explicitly connected to one Openship workspace. */
    async listByOrganization(organizationId: string) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.organizationId, organizationId),
          eq(gitInstallation.provider, "github"),
          isNull(gitInstallation.suspendedAt),
        ),
      });
    },

    /** Find every workspace binding for an App installation id. */
    async findByInstallationIdForProvider(installationId: number) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.installationId, installationId),
        ),
      });
    },

    /**
     * Atomic upsert keyed on (provider, owner, organizationId). The workspace
     * is the security boundary; userId is attribution, not ownership. A
     * re-install refreshes the row while concurrent callbacks converge.
     */
    async upsert(data: Omit<NewGitInstallation, "id">) {
      return upsertInstallation(db, data);
    },

    /**
     * Consume the verified one-time setup state, upsert the workspace binding,
     * and reconcile every existing project source in one transaction. A crash
     * can therefore leave either the whole claim committed or the nonce still
     * retryable—never a consumed state with a half-bound installation.
     */
    async claimWithState(
      state: string,
      data: Omit<NewGitInstallation, "id">,
    ): Promise<GitInstallation | null> {
      return db.transaction(async (tx) => {
        const [binding] = await tx
          .delete(githubInstallState)
          .where(
            and(
              eq(githubInstallState.state, state),
              eq(githubInstallState.userId, data.userId),
              eq(githubInstallState.organizationId, data.organizationId),
              gt(githubInstallState.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!binding) return null;

        const installation = await upsertInstallation(tx, data);
        await rebindGitHubInstallationRows(
          tx,
          data.organizationId,
          data.owner,
          data.installationId,
        );
        return installation;
      });
    },

    /** Replace one user's OAuth-derived snapshot inside one workspace only. */
    async replaceForUserInOrganization(
      userId: string,
      organizationId: string,
      data: Array<Omit<NewGitInstallation, "id" | "userId" | "provider" | "organizationId">>,
    ) {
      const rows = data.map((installation) => ({
        id: randomUUID(),
        userId,
        organizationId,
        provider: "github",
        ...installation,
        owner: installation.owner.toLowerCase(),
      }));

      const replace = async (tx: Database) => {
        await tx
          .delete(gitInstallation)
          .where(
            and(
              eq(gitInstallation.userId, userId),
              eq(gitInstallation.organizationId, organizationId),
              eq(gitInstallation.provider, "github"),
            ),
          );

        if (rows.length > 0) {
          for (const row of rows) {
            await tx.insert(gitInstallation).values(row).onConflictDoUpdate({
              target: [
                gitInstallation.provider,
                gitInstallation.owner,
                gitInstallation.organizationId,
              ],
              set: {
                userId,
                installationId: row.installationId,
                ownerType: row.ownerType,
                providerUserId: row.providerUserId ?? null,
                providerOwnerId: row.providerOwnerId ?? null,
                isOrg: row.isOrg ?? false,
                suspendedAt: row.suspendedAt ?? null,
                updatedAt: new Date(),
              },
            });
          }
        }
      };

      await db.transaction(replace);
    },

    /** Remove installation by user + owner */
    async removeByOwner(userId: string, owner: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.owner, owner.toLowerCase()),
          ),
        );
    },

    /** Remove installation by installation_id */
    async removeByInstallationId(userId: string, installationId: number) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Remove installation rows by installation_id, regardless of linked OAuth account */
    async removeByInstallationIdForProvider(installationId: number) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Mark a reversible GitHub suspension without losing workspace ownership. */
    async suspendByInstallationIdForProvider(installationId: number) {
      return db
        .update(gitInstallation)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Remove all GitHub installations for a user */
    async removeAllForUser(userId: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
          ),
        );
    },
  };
}
