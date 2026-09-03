import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import { deploymentEnvPayload, savedDeploymentEnvRows } from "./env-payload";

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
