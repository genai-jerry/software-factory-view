#!/usr/bin/env node
// Which packages a pull request's check has to typecheck, build and test.
//
//   node scripts/ci-scope.mjs <base-ref>
//
// Prints, and appends to $GITHUB_OUTPUT when it is set:
//   run=false            nothing but documentation changed: there is nothing to check
//   run=true scope=all   something every package rests on changed (the lockfile, a
//                        root config, a workflow, ...): check everything
//   run=true scope=some  only these packages, and every package that uses them:
//     test=--filter @console/web --filter ...    typecheck and test these
//     build=--filter @console/web... ...         build these and what they depend on
//
// A package counts as changed when a file under its folder changed; the packages that
// use it come from each package.json, plus the web app's alias into core's decisions
// (apps/web/vite.config.ts), which no package.json records.
//
// The unit is the package, never the single file: TypeScript checks a file against
// every file that calls it, so one changed file can break another that did not change,
// and tests read things no import graph shows (migrations, fixtures, config).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Documentation only: changing it cannot change what the code does. */
export function isDoc(file) {
  return (
    /\.md$/i.test(file) ||
    file.startsWith("docs/") ||
    file === "LICENSE" ||
    file.startsWith(".github/ISSUE_TEMPLATE/")
  );
}

/** Uses that no package.json records: the web app reads core's decisions by alias. */
const EXTRA_USERS = { "@console/core": ["@console/web"] };

/** The workspace: folder -> { name, deps on other workspace packages }. */
export function readWorkspace(root = ".") {
  const packages = [];
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(root, group))) continue;
    for (const dir of readdirSync(join(root, group))) {
      const file = join(root, group, dir, "package.json");
      if (!existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, "utf8"));
      const deps = Object.keys({ ...json.dependencies, ...json.devDependencies });
      packages.push({ dir: `${group}/${dir}`, name: json.name, deps });
    }
  }
  const names = new Set(packages.map((p) => p.name));
  for (const p of packages) p.deps = p.deps.filter((d) => names.has(d));
  return packages;
}

/** What the check covers for these changed files. */
export function scope(files, packages) {
  const code = files.filter((f) => !isDoc(f));
  if (code.length === 0) return { run: false };
  const changed = new Set();
  for (const file of code) {
    const owner = packages.find((p) => file.startsWith(`${p.dir}/`));
    if (!owner) return { run: true, all: true, why: file };
    changed.add(owner.name);
  }
  // Every package that uses a changed one, however indirectly.
  const users = new Map(packages.map((p) => [p.name, new Set(EXTRA_USERS[p.name] ?? [])]));
  for (const p of packages) for (const d of p.deps) users.get(d)?.add(p.name);
  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    for (const u of users.get(queue.shift()) ?? []) {
      if (!affected.has(u)) {
        affected.add(u);
        queue.push(u);
      }
    }
  }
  return { run: true, all: false, packages: [...affected].sort() };
}

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: ci-scope.mjs <base-ref>");
    process.exit(2);
  }
  const files = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const result = scope(files, readWorkspace());
  const out = [`run=${result.run}`];
  if (!result.run) {
    console.log(`Only documentation changed (${files.length} file(s)): nothing to check.`);
  } else if (result.all) {
    console.log(`${result.why} is outside any one package: checking everything.`);
    out.push("scope=all");
  } else {
    console.log(`Checking ${result.packages.join(", ")} (changed, or using what changed).`);
    out.push(
      "scope=some",
      `test=${result.packages.map((p) => `--filter ${p}`).join(" ")}`,
      `build=${result.packages.map((p) => `--filter ${p}...`).join(" ")}`,
    );
  }
  for (const line of out) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
