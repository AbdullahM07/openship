import { isMaskedValue, looksLikeSecretKey } from "@repo/core";

export interface StoredProjectEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface PersistedBuildAccessEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface BuildAccessEnvResolution {
  /** Encrypted values frozen onto the deployment and later decrypted for the runtime. */
  deploymentEnvVars: Record<string, string> | null;
  /** Full replacement for project defaults; null means the request supplied no env map. */
  projectEnvVars: PersistedBuildAccessEnvVar[] | null;
}

/**
 * Resolve the flat env map accepted by the build-access endpoint against the
 * project's stored encrypted rows.
 *
 * The dashboard cannot send an existing secret back in plaintext: its public
 * representation is either the mask sentinel or (for older clients) an empty
 * string. Both mean "unchanged" for an existing secret, so retain its ciphertext
 * in the deployment snapshot and in the full project-env replacement. Empty
 * non-secret values remain real values, and omitted keys remain deleted by the
 * caller's full-map write.
 */
export function resolveBuildAccessEnv(
  incoming: Record<string, string> | null | undefined,
  stored: readonly StoredProjectEnvVar[],
  encryptValue: (value: string) => string,
): BuildAccessEnvResolution {
  if (!incoming || Object.keys(incoming).length === 0) {
    const deploymentEnvVars = Object.fromEntries(stored.map((row) => [row.key, row.value]));
    return {
      deploymentEnvVars: Object.keys(deploymentEnvVars).length > 0 ? deploymentEnvVars : null,
      projectEnvVars: null,
    };
  }

  const storedByKey = new Map(stored.map((row) => [row.key, row]));
  const projectEnvVars: PersistedBuildAccessEnvVar[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const previous = storedByKey.get(key);
    const keepStoredSecret = previous?.isSecret && (value === "" || isMaskedValue(value));

    // A mask with no secret behind it is display data, never a runtime value.
    // Dropping it mirrors unmaskEnv's whole-map semantics.
    if (isMaskedValue(value) && !keepStoredSecret) continue;

    projectEnvVars.push({
      key,
      value: keepStoredSecret ? previous.value : encryptValue(value),
      isSecret: previous?.isSecret ?? looksLikeSecretKey(key),
    });
  }

  return {
    deploymentEnvVars:
      projectEnvVars.length > 0
        ? Object.fromEntries(projectEnvVars.map((row) => [row.key, row.value]))
        : null,
    projectEnvVars,
  };
}
