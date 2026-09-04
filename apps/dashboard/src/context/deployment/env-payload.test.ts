import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import {
  deploymentEnvPayload,
  mergePreparedSourceEnv,
  savedDeploymentEnvRows,
} from "./env-payload";

describe("mergePreparedSourceEnv", () => {
  it("activates openship.json keys, keeps .env opt-in, and preserves operator overrides", () => {
    const result = mergePreparedSourceEnv(
      [{ key: "SHARED", value: "operator", visible: true }],
      {
        DECLARED: ENV_MASK,
        SHARED: ENV_MASK,
        DOT_ENV_ONLY: ENV_MASK,
      },
      ["DECLARED", "SHARED"],
    );

    expect(result.envVars).toEqual([
      { key: "SHARED", value: "operator", visible: true },
      { key: "DECLARED", value: ENV_MASK, visible: true, preserveValue: true },
    ]);
    expect(result.rootEnvVars).toEqual([
      { key: "DOT_ENV_ONLY", value: ENV_MASK, visible: true, preserveValue: true },
    ]);
    expect(deploymentEnvPayload(result.envVars)).toEqual({
      SHARED: "operator",
      DECLARED: ENV_MASK,
    });
  });
});

describe("deploymentEnvPayload", () => {
  it("marks only saved production secrets for preservation", () => {
    expect(
      savedDeploymentEnvRows([
        { key: "AUTH_SECRET", value: ENV_MASK, isSecret: true, environment: "production" },
        { key: "PUBLIC_SETTING", value: "enabled", isSecret: false, environment: "production" },
        { key: "PREVIEW_ONLY", value: "preview", isSecret: false, environment: "preview" },
      ]),
    ).toEqual([
      { key: "AUTH_SECRET", value: "", visible: true, preserveValue: true },
      { key: "PUBLIC_SETTING", value: "enabled", visible: true, preserveValue: undefined },
    ]);
  });

  it("#801: sends a preserve sentinel for an unreadable saved secret", () => {
    expect(
      deploymentEnvPayload([
        { key: "AUTH_SECRET", value: "", visible: false, preserveValue: true },
        { key: "PUBLIC_SETTING", value: "enabled", visible: true },
      ]),
    ).toEqual({ AUTH_SECRET: ENV_MASK, PUBLIC_SETTING: "enabled" });
  });

  it("keeps an explicitly entered empty value distinct from a preserved secret", () => {
    expect(deploymentEnvPayload([{ key: "OPTIONAL", value: "", visible: true }])).toEqual({
      OPTIONAL: "",
    });
  });
});
