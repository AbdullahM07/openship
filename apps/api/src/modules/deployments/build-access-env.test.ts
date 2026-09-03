import { ENV_MASK } from "@repo/core";
import { describe, expect, it, vi } from "vitest";

import { resolveBuildAccessEnv, type StoredProjectEnvVar } from "./build-access-env";

const stored: StoredProjectEnvVar[] = [
  { key: "API_TOKEN", value: "cipher:original-secret", isSecret: true },
  { key: "PUBLIC_URL", value: "cipher:https://old.example", isSecret: false },
];

const encryptValue = (value: string) => `cipher:${value}`;

describe("resolveBuildAccessEnv", () => {
  it("preserves a stored secret when an older client sends an empty placeholder", () => {
    const resolved = resolveBuildAccessEnv(
      { API_TOKEN: "", PUBLIC_URL: "https://new.example" },
      stored,
      encryptValue,
    );

    expect(resolved.deploymentEnvVars).toEqual({
      API_TOKEN: "cipher:original-secret",
      PUBLIC_URL: "cipher:https://new.example",
    });
    expect(resolved.projectEnvVars).toEqual([
      { key: "API_TOKEN", value: "cipher:original-secret", isSecret: true },
      { key: "PUBLIC_URL", value: "cipher:https://new.example", isSecret: false },
    ]);
  });

  it("preserves a stored secret when the mask sentinel is echoed", () => {
    const resolved = resolveBuildAccessEnv({ API_TOKEN: ENV_MASK }, stored, encryptValue);

    expect(resolved.deploymentEnvVars).toEqual({ API_TOKEN: "cipher:original-secret" });
    expect(resolved.projectEnvVars).toEqual([
      { key: "API_TOKEN", value: "cipher:original-secret", isSecret: true },
    ]);
  });

  it("drops a mask sentinel that has no stored secret behind it", () => {
    const encrypt = vi.fn(encryptValue);

    const resolved = resolveBuildAccessEnv({ UNKNOWN: ENV_MASK }, stored, encrypt);

    expect(encrypt).not.toHaveBeenCalled();
    expect(resolved.deploymentEnvVars).toBeNull();
    expect(resolved.projectEnvVars).toEqual([]);
  });

  it("encrypts and stores an explicitly changed secret", () => {
    const encrypt = vi.fn(encryptValue);

    const resolved = resolveBuildAccessEnv({ API_TOKEN: "rotated" }, stored, encrypt);

    expect(encrypt).toHaveBeenCalledWith("rotated");
    expect(resolved.deploymentEnvVars).toEqual({ API_TOKEN: "cipher:rotated" });
    expect(resolved.projectEnvVars).toEqual([
      { key: "API_TOKEN", value: "cipher:rotated", isSecret: true },
    ]);
  });

  it("keeps an empty non-secret value as an explicit empty value", () => {
    const resolved = resolveBuildAccessEnv({ PUBLIC_URL: "" }, stored, encryptValue);

    expect(resolved.deploymentEnvVars).toEqual({ PUBLIC_URL: "cipher:" });
    expect(resolved.projectEnvVars).toEqual([
      { key: "PUBLIC_URL", value: "cipher:", isSecret: false },
    ]);
  });

  it("uses all stored values without scheduling a project write when env is omitted", () => {
    const encrypt = vi.fn(encryptValue);

    const resolved = resolveBuildAccessEnv(undefined, stored, encrypt);

    expect(encrypt).not.toHaveBeenCalled();
    expect(resolved.deploymentEnvVars).toEqual({
      API_TOKEN: "cipher:original-secret",
      PUBLIC_URL: "cipher:https://old.example",
    });
    expect(resolved.projectEnvVars).toBeNull();
  });

  it("retains full-map replacement semantics for omitted keys", () => {
    const resolved = resolveBuildAccessEnv(
      { PUBLIC_URL: "https://only.example" },
      stored,
      encryptValue,
    );

    expect(resolved.deploymentEnvVars).toEqual({
      PUBLIC_URL: "cipher:https://only.example",
    });
    expect(resolved.projectEnvVars).toEqual([
      { key: "PUBLIC_URL", value: "cipher:https://only.example", isSecret: false },
    ]);
  });

  it("treats an empty map like an omitted map", () => {
    expect(resolveBuildAccessEnv({}, stored, encryptValue)).toEqual(
      resolveBuildAccessEnv(undefined, stored, encryptValue),
    );
  });
});
