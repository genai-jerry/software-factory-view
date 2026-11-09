import { beforeEach, describe, expect, it } from "vitest";
import { defaultWorkRepo, groupedTargets, rememberWorkRepo, type WorkTarget } from "./work-home.js";

const t = (id: string, projectId: string | null, extra: Partial<WorkTarget> = {}): WorkTarget => ({
  id,
  fullName: `jerry/${id}`,
  projectId,
  projectName: projectId ? projectId.toUpperCase() : null,
  factoryEnabled: true,
  ...extra,
});
const beacon = [t("beacon-api", "beacon"), t("beacon-web", "beacon", { coordination: true }), t("lens", "lens")];

beforeEach(() => localStorage.clear());

describe("where new work goes by default", () => {
  it("is the focused repo", () => {
    expect(defaultWorkRepo(beacon, { project: "beacon", repo: "beacon-api" })).toBe("beacon-api");
  });

  it("is the focused project's coordination repo, not the first repo of the org", () => {
    expect(defaultWorkRepo(beacon, { project: "beacon", repo: "" })).toBe("beacon-web");
    expect(defaultWorkRepo(beacon, { project: "lens", repo: "" })).toBe("lens");
  });

  it("remembers the repo last used in that project", () => {
    rememberWorkRepo(beacon[0]);
    expect(defaultWorkRepo(beacon, { project: "beacon", repo: "" })).toBe("beacon-api");
    expect(defaultWorkRepo(beacon, { project: "lens", repo: "" })).toBe("lens"); // another project keeps its own
    expect(defaultWorkRepo(beacon, { project: "", repo: "" })).toBe("beacon-api"); // no focus: the last one used
  });

  it("lists the focused project first", () => {
    expect(groupedTargets(beacon, "lens").map(([name]) => name)).toEqual(["LENS", "BEACON"]);
  });
});
