import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  check: vi.fn(),
}));

vi.mock("../../../src/modules/mail/mail-port-reachability.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkMailPortReachability: h.check,
}));

import {
  MAIL_SETUP_STEPS,
  STEP_RUNNERS,
  STEP_TIMEOUT_MS,
  stepVerifyMailReachability,
} from "../../../src/modules/mail/mail.service";

const executor = {} as never;

function reading(status: "ok" | "fail" | "unknown") {
  return {
    hostname: "mail.example.com",
    address: status === "unknown" ? null : "203.0.113.10",
    checkedAt: 0,
    status,
    detail: status === "unknown" ? "Public DNS has no A or AAAA address." : undefined,
    ports: [
      {
        key: "smtps",
        port: 465,
        label: "SMTP submission (TLS)",
        status: status === "fail" ? "blocked" : status === "unknown" ? "unknown" : "reachable",
        listening: true,
        exposed: true,
        reachable: status === "ok" ? true : status === "fail" ? false : null,
        failure: status === "fail" ? "timeout" : undefined,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mail setup public reachability gate", () => {
  it("is the terminal setup step so setup cannot complete green before it runs", () => {
    expect(MAIL_SETUP_STEPS.at(-1)).toMatchObject({ id: 9, key: "verify_reachability" });
    for (const step of MAIL_SETUP_STEPS) {
      expect(STEP_RUNNERS[step.id], `runner for ${step.key}`).toBeTypeOf("function");
      expect(STEP_TIMEOUT_MS[step.key], `timeout for ${step.key}`).toBeGreaterThan(0);
    }
  });

  it("blocks completion when the host listens but the public port is filtered", async () => {
    h.check.mockResolvedValue(reading("fail"));

    const result = await stepVerifyMailReachability(executor, "example.com", vi.fn());

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/provider firewall|security group/i);
    expect(result.data?.reachability).toMatchObject({ status: "fail" });
  });

  it("warns without inventing an outage when the external probe is unavailable", async () => {
    h.check.mockResolvedValue(reading("unknown"));

    const result = await stepVerifyMailReachability(executor, "example.com", vi.fn());

    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/Public DNS/i);
  });
});
