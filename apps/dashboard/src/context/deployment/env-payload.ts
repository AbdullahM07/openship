import { isMaskedValue } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";
import {
  computeProjectEnvDiff,
  serializeNewProjectEnv,
  type PersistedProjectEnv,
  type ProjectEnvDiff,
} from "@/lib/project-env-diff";

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

export type DeploymentEnvPersistencePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Existing projects apply this partial merge before save/deploy. */
      merge: ProjectEnvDiff | null;
      /** Only a new project sends env through build/access. */
      buildAccessEnvVars: Record<string, string> | undefined;
    };

/**
 * Decide which persistence path owns deployment-wizard env changes.
 *
 * A new project has no env store yet, so build/access receives its values and
 * persists them. An existing project is patched through the same partial merge
 * contract as the dedicated env editor, then build/access reads that store.
 * Requiring a loaded baseline for existing projects prevents a failed env read
 * from being mistaken for an empty environment and deleting data.
 */
export function planDeploymentEnvPersistence({
  projectId,
  envVars,
  baseline,
}: {
  projectId?: string;
  envVars: readonly EnvironmentVariable[];
  baseline: readonly PersistedProjectEnv[] | null;
}): DeploymentEnvPersistencePlan {
  if (!projectId) {
    const serialized = serializeNewProjectEnv(envVars);
    return serialized.ok
      ? { ok: true, merge: null, buildAccessEnvVars: serialized.envVars }
      : serialized;
  }

  if (baseline === null) {
    return {
      ok: false,
      error: "Project environment was not loaded. Reload the page and try again.",
    };
  }

  const result = computeProjectEnvDiff(envVars, baseline, {
    // openship.json values are owned and resolved by the server-side source
    // scan. They intentionally have no originalKey/project-env baseline row.
    ignoreUntrackedPreserved: true,
  });
  return result.ok ? { ok: true, merge: result.diff, buildAccessEnvVars: undefined } : result;
}
