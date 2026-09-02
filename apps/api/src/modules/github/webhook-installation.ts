/**
 * GitHub webhook installation events — installation.created / deleted /
 * suspend / unsuspend.
 */

import { repos } from "@repo/db";
import { env } from "../../config/env";
import {
  getGitHubAuthMode,
  invalidateOrgGitHubCache,
  invalidateUserGitHubCache,
} from "./github.auth";
import type { WebhookHandlerResult } from "../webhooks/webhook.types";
import type { GitHubInstallationPayload } from "./github.types";

// ─── Installation events ─────────────────────────────────────────────────────

export async function handleInstallation(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  // SaaS-only contract: the GitHub App is owned by openship.io, so
  // installation events ONLY have authoritative meaning on the SaaS
  // (env.CLOUD_MODE=true). On a self-hosted instance the App's webhook
  // is configured to point at api.openship.io — an installation event
  // arriving here means a misconfiguration. The local DB MUST NOT
  // become a parallel source of truth for installations: cloud-app mode
  // reads installations strictly from SaaS, and a stale local row would
  // lie for up to 50min after the user uninstalls or moves the App.
  // Acknowledge with 200 (so GitHub doesn't retry forever) and refuse to
  // touch local state.
  //
  // The exception is effective local App mode (explicit or auto-detected),
  // where the operator owns the App and its webhook legitimately points here.
  if (!env.CLOUD_MODE && getGitHubAuthMode() !== "app") {
    console.log(
      `[GitHub Webhook] Ignoring installation.${payload.action} on self-hosted instance — SaaS (api.openship.io) is the authoritative source for GitHub App installations.`,
    );
    return {
      success: true,
      event: "installation",
      message: "Ignored on self-hosted — SaaS is the source of truth",
    };
  }

  switch (payload.action) {
    case "created":
      return handleInstallationCreated(payload);
    case "deleted":
      return handleInstallationDeleted(payload);
    case "suspend":
      return handleInstallationSuspended(payload);
    case "unsuspend":
      return handleInstallationCreated(payload); // Re-upsert to restore
    default:
      return {
        success: true,
        event: "installation",
        message: `Installation action '${payload.action}' not handled`,
      };
  }
}

async function handleInstallationCreated(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();
  const accountType = payload.installation.account.type;

  // Installation webhooks carry no Openship workspace binding and can arrive
  // before or after the browser setup redirect. They may refresh a row that the
  // verified claim callback already owns, but must never invent one by guessing
  // from sender membership order.
  const existing = await repos.gitInstallation
    .findByInstallationIdForProvider(installationId)
    .catch(() => []);
  if (existing.length === 0) {
    console.log(
      `[GitHub Webhook] installation.created for ${accountLogin} is awaiting the state-bound setup callback; no workspace row was guessed.`,
    );
    return {
      success: true,
      event: "installation",
      message: "Awaiting authenticated setup callback",
    };
  }

  await Promise.all(existing.map((row) => repos.gitInstallation.upsert({
    userId: row.userId,
    organizationId: row.organizationId,
    provider: "github",
    installationId,
    owner: accountLogin,
    ownerType: accountType,
    providerUserId: String(payload.sender.id),
    providerOwnerId: String(payload.installation.account.id),
    isOrg: accountType === "Organization",
  })));
  await Promise.all([
    ...new Set(existing.map((row) => row.userId)),
  ].map((userId) => invalidateUserGitHubCache(userId)));
  await Promise.all([
    ...new Set(existing.map((row) => row.organizationId)),
  ].map((organizationId) => invalidateOrgGitHubCache(organizationId)));

  console.log(
    `[GitHub Webhook] installation.${payload.action} refreshed ${existing.length} workspace binding(s) for ${accountLogin}`,
  );
  return {
    success: true,
    event: "installation",
    message: `Installation created for ${accountLogin}`,
  };
}

async function handleInstallationDeleted(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const existing = await repos.gitInstallation
    .findByInstallationIdForProvider(installationId)
    .catch(() => []);
  await repos.gitInstallation.removeByInstallationIdForProvider(installationId);
  await Promise.all([...new Set(existing.map((row) => row.userId))]
    .map((userId) => invalidateUserGitHubCache(userId)));
  await Promise.all([...new Set(existing.map((row) => row.organizationId))]
    .map((organizationId) => invalidateOrgGitHubCache(organizationId)));
  await Promise.all([...new Set(existing.map((row) => row.organizationId))].map(
    (organizationId) =>
    repos.resourceGrant
      .deleteGitHubGrantsForOwner(organizationId, accountLogin)
      .catch(() => 0),
  ));

  return { success: true, event: "installation", message: "Installation removed" };
}

async function handleInstallationSuspended(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  // Suspension is reversible. Preserve the workspace binding and grants so an
  // unsuspend event becomes usable again without an impossible second setup
  // callback; GitHub will refuse token minting while it is suspended.
  const existing = await repos.gitInstallation
    .findByInstallationIdForProvider(installationId)
    .catch(() => []);
  await repos.gitInstallation.suspendByInstallationIdForProvider(installationId);
  await Promise.all([...new Set(existing.map((row) => row.userId))]
    .map((userId) => invalidateUserGitHubCache(userId)));
  await Promise.all([...new Set(existing.map((row) => row.organizationId))]
    .map((organizationId) => invalidateOrgGitHubCache(organizationId)));
  console.log(`[GitHub Webhook] Installation suspended for ${accountLogin}; workspace bindings retained`);

  return { success: true, event: "installation", message: `Installation suspended for ${accountLogin}` };
}
