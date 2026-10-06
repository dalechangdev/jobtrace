/**
 * Enforces the workspace dependency rule from PLAN.md section 4:
 *   - `@jobtrace/core` depends on no other workspace package
 *   - packages never depend on apps
 *   - every `@jobtrace/*` import in source is declared in that package's package.json
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors: string[] = [];

interface Workspace {
  dir: string;
  name: string;
  kind: "apps" | "packages";
  deps: Set<string>;
}

function readWorkspaces(kind: Workspace["kind"]): Workspace[] {
  const base = join(root, kind);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((entry) => join(base, entry))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const deps = { ...manifest.dependencies, ...manifest.devDependencies };
      return { dir, name: manifest.name, kind, deps: new Set(Object.keys(deps)) };
    });
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const workspaces = [...readWorkspaces("apps"), ...readWorkspaces("packages")];
const appNames = new Set(workspaces.filter((w) => w.kind === "apps").map((w) => w.name));

for (const workspace of workspaces) {
  const internal = [...workspace.deps].filter((dep) => dep.startsWith("@jobtrace/"));
  if (workspace.name === "@jobtrace/core" && internal.length > 0) {
    errors.push(`@jobtrace/core must not depend on workspace packages: ${internal.join(", ")}`);
  }
  if (workspace.kind === "packages") {
    for (const dep of internal.filter((name) => appNames.has(name))) {
      errors.push(`${workspace.name} (package) must not depend on ${dep} (app)`);
    }
  }
  for (const file of sourceFiles(join(workspace.dir, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+["'](@jobtrace\/[a-z-]+)/g)) {
      const imported = match[1] as string;
      if (imported !== workspace.name && !workspace.deps.has(imported)) {
        errors.push(`${file.slice(root.length)} imports ${imported}, which is not a dependency`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `dependency rule: ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`dependency rules ok (${workspaces.length} workspaces)`);
}
