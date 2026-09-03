import { ENV_MASK } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";

/** Keep an unreadable API secret distinct from an explicitly empty value. */
export function savedDeploymentEnvRows(
  rows: Array<{ key: string; value: string; isSecret: boolean; environment: string }>,
): EnvironmentVariable[] {
  return rows
    .filter((row) => row.environment === "production")
    .map((row) => ({
      key: row.key,
      value: row.isSecret ? "" : row.value,
      visible: true,
      preserveValue: row.isSecret || undefined,
    }));
}

/**
 * Serialize the wizard's project env rows without turning unreadable saved
 * secrets into empty strings. The mask is a transport sentinel; the API
 * resolves it against the stored encrypted project row before snapshotting.
 */
export function deploymentEnvPayload(
  envVars: EnvironmentVariable[] | null | undefined,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const envVar of envVars ?? []) {
    const key = envVar.key.trim();
    if (!key) continue;
    result[key] = envVar.preserveValue ? ENV_MASK : envVar.value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
