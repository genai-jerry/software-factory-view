// node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDoc, readWorkspace, scope } from "./ci-scope.mjs";

const workspace = readWorkspace();

test("documentation alone needs no check", () => {
  assert.deepEqual(scope(["README.md", "docs/guide.md", "apps/web/README.md", "LICENSE"], workspace), { run: false });
  assert.ok(isDoc(".github/ISSUE_TEMPLATE/bug.yml"));
  assert.ok(!isDoc(".github/workflows/deploy.yml"));
});

test("a web-only change checks the web app alone", () => {
  assert.deepEqual(scope(["apps/web/src/pages/Work.tsx", "README.md"], workspace), {
    run: true,
    all: false,
    packages: ["@console/web"],
  });
});

test("a change to core checks everything that uses core, the web app's alias included", () => {
  const { packages } = scope(["packages/core/src/decisions/work.ts"], workspace);
  assert.deepEqual(packages, ["@console/api", "@console/core", "@console/insight", "@console/web", "@console/worker"]);
});

test("a change to db checks db and the apps built on it, not the web app", () => {
  const { packages } = scope(["packages/db/migrations/0099_x.sql"], workspace);
  assert.deepEqual(packages, ["@console/api", "@console/db", "@console/worker"]);
});

test("a change outside every package checks everything", () => {
  for (const file of ["pnpm-lock.yaml", "package.json", "tsconfig.base.json", ".github/workflows/deploy.yml", "patches/x.patch"]) {
    assert.deepEqual(scope([file], workspace), { run: true, all: true, why: file }, file);
  }
});
