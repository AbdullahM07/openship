import { ENV_MASK, isMaskedValue } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";

function sourceEnvRows(env?: Record<string, string>): EnvironmentVariable[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    key,
    value,
    visible: true,
    // Source values are masked at every read boundary. Preserve the sentinel so
    // deploy can recover the value from its own trusted source read.
    preserveValue: isMaskedValue(value) || undefined,
  }));
}

/**
 * Partition a prepare response's source env by ownership. Values explicitly
 * declared in openship.json are active deploy defaults; unrelated `.env` rows
 * stay behind the Import action. Existing operator rows always win by key.
 */
export function mergePreparedSourceEnv(
  current: EnvironmentVariable[],
  rootEnv?: Record<string, string>,
  openshipEnvKeys: string[] = [],
): { envVars: EnvironmentVariable[]; rootEnvVars: EnvironmentVariable[] } {
  const rows = sourceEnvRows(rootEnv);
  const declaredKeys = new Set(openshipEnvKeys);
  const declared = rows.filter((row) => declaredKeys.has(row.key));
  const owned = new Set(current.map((row) => row.key).filter(Boolean));

  return {
    envVars: [...current, ...declared.filter((row) => row.key && !owned.has(row.key))],
    rootEnvVars: rows.filter((row) => !declaredKeys.has(row.key)),
  };
}

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
