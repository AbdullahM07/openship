import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findByName: vi.fn(),
  listByProject: vi.fn(),
  listByDeployment: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const domainRepo = vi.hoisted(() => ({ listByProject: vi.fn() }));
const freeGate = vi.hoisted(() => ({ assertFreeEndpointsAllowed: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      service: serviceRepo,
      deployment: deploymentRepo,
      domain: domainRepo,
    },
  };
});

vi.mock("../../../src/lib/free-domain-guard", () => freeGate);
vi.mock("../../../src/lib/controller-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/controller-helpers")>();
  return { ...actual, platform: () => ({ runtime: { name: "docker" } }) };
});

import { createService, updateService } from "../../../src/modules/services/service.service";

const ctx = { organizationId: "org_1" } as never;
const project = { id: "proj_1", organizationId: "org_1", slug: "acme" };

/** A compose row imported from a file, so it carries BOTH the text and the argv. */
const composeRow = () => ({
  id: "svc_1",
  projectId: project.id,
  name: "server",
  kind: "compose",
  enabled: true,
  environment: {},
  ports: [],
  command: "ak server",
  commandArgv: ["ak", "server"],
  exposed: false,
  publicEndpoints: [],
});

const writtenPatch = () => serviceRepo.update.mock.calls.at(-1)?.[1] as Record<string, any>;
const createdRow = () => serviceRepo.create.mock.calls.at(-1)?.[0] as Record<string, any>;

/**
 * `commandArgv` — not the text `command` — is what the runtime hands Docker
 * (`resolveComposeCmd`), and it only falls back to `sh -c <command>` for legacy
 * rows that have no argv. Both editors here take the dashboard's one-line
 * `command` field and NO argv, which left the two columns free to disagree.
 *
 * The edit half is the live bug: `toComposeSpec` backfills an argv only when the
 * stored one is null, so a STALE argv survives the deploy-time `syncFromCompose`
 * and the container keeps running the old command. The create half stores no argv
 * at all, which that same backfill does cover — asserted here so a row is written
 * consistently instead of depending on a later repair step.
 */
describe("service command → argv (#332)", () => {
  beforeEach(() => {
    projectRepo.findById.mockReset().mockResolvedValue(project);
    serviceRepo.findById.mockReset().mockResolvedValue(composeRow());
    serviceRepo.findByName.mockReset().mockResolvedValue(null);
    serviceRepo.listByProject.mockReset().mockResolvedValue([]);
    serviceRepo.listByDeployment.mockReset().mockResolvedValue([]);
    serviceRepo.update.mockReset().mockResolvedValue(undefined);
    serviceRepo.create.mockReset().mockImplementation(async (row: Record<string, unknown>) => ({
      id: "svc_new",
      ...row,
    }));
    deploymentRepo.findById.mockReset().mockResolvedValue(null);
    domainRepo.listByProject.mockReset().mockResolvedValue([]);
    freeGate.assertFreeEndpointsAllowed.mockReset().mockResolvedValue(undefined);
  });

  it("re-derives the argv when an edit sends only the text command", async () => {
    await updateService(ctx, project.id, "svc_1", { command: "ak worker" } as never);

    const patch = writtenPatch();
    expect(patch.command).toBe("ak worker");
    // Without this the row kept ["ak","server"] and the container never switched.
    expect(patch.commandArgv).toEqual(["ak", "worker"]);
  });

  it("clears the argv when an edit clears the command", async () => {
    await updateService(ctx, project.id, "svc_1", { command: "" } as never);

    const patch = writtenPatch();
    expect(patch.command).toBeNull();
    // Null argv AND null command is the only shape that hands the image's own
    // CMD back; a stale argv would keep overriding it forever.
    expect(patch.commandArgv).toBeNull();
  });

  it("keeps an explicit argv over the text command", async () => {
    await updateService(ctx, project.id, "svc_1", {
      command: "sh -c 'echo hi && ak server'",
      commandArgv: ["sh", "-c", "echo hi && ak server"],
    } as never);

    // An argv-aware caller (compose parser, CLI, snapshot replay) is never
    // second-guessed — re-splitting its argv would mangle the quoted script.
    expect(writtenPatch().commandArgv).toEqual(["sh", "-c", "echo hi && ak server"]);
  });

  it("derives the argv on create instead of storing none", async () => {
    await createService(ctx, project.id, {
      name: "worker",
      kind: "compose",
      image: "ghcr.io/goauthentik/server:latest",
      command: "ak worker",
    } as never);

    // The app installer forwards a template's string command through here. A null
    // argv leaves the row one missed backfill away from `sh -c "ak worker"`, which
    // hands `sh` to the image's `dumb-init -- ak` entrypoint.
    expect(createdRow().commandArgv).toEqual(["ak", "worker"]);
  });
});
