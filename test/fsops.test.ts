import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyOutputs } from "../src/providers/fsops.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quiver-fsops-"));
  roots.push(root);
  return root;
};
const emptyPlan = (targetRoot: string) => ({
  targetRoot,
  files: [],
  symlinks: [],
  removeFiles: [],
  removeDirs: [],
  managedDirs: [],
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("applyOutputs containment", () => {
  it("rejects an outside output before writing any file", () => {
    const targetRoot = tempRoot();
    const outside = tempRoot();
    const first = join(targetRoot, "generated.json");

    expect(() =>
      applyOutputs({
        ...emptyPlan(targetRoot),
        files: [
          { path: first, content: "inside\n" },
          { path: join(outside, "outside.json"), content: "outside\n" },
        ],
      }),
    ).toThrow(/outside target root/);
    expect(existsSync(first)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects writes and cleanup through symlinked managed parents",
    () => {
      const targetRoot = tempRoot();
      const outside = tempRoot();
      writeFileSync(join(outside, "stale"), "keep\n");
      symlinkSync(outside, join(targetRoot, ".opencode"), "dir");

      expect(() =>
        applyOutputs({
          ...emptyPlan(targetRoot),
          files: [
            {
              path: join(targetRoot, ".opencode/config.json"),
              content: "{}\n",
            },
          ],
          managedDirs: [
            { path: join(targetRoot, ".opencode"), expected: new Set() },
          ],
        }),
      ).toThrow(/symlinked parent/);
      expect(readFileSync(join(outside, "stale"), "utf8")).toBe("keep\n");
      expect(existsSync(join(outside, "config.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a generated file whose leaf is a symlink",
    () => {
      const targetRoot = tempRoot();
      const outside = tempRoot();
      const outsideFile = join(outside, "config.json");
      writeFileSync(outsideFile, "keep\n");
      const output = join(targetRoot, "config.json");
      symlinkSync(outsideFile, output, "file");

      expect(() =>
        applyOutputs({
          ...emptyPlan(targetRoot),
          files: [{ path: output, content: "replace\n" }],
        }),
      ).toThrow(/symlinked parent/);
      expect(readFileSync(outsideFile, "utf8")).toBe("keep\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects cleanup when the managed directory is a symlink",
    () => {
      const targetRoot = tempRoot();
      const outside = tempRoot();
      writeFileSync(join(outside, "stale"), "keep\n");
      const managed = join(targetRoot, ".claude/skills");
      mkdirSync(join(targetRoot, ".claude"));
      symlinkSync(outside, managed, "dir");

      expect(() =>
        applyOutputs({
          ...emptyPlan(targetRoot),
          managedDirs: [{ path: managed, expected: new Set() }],
        }),
      ).toThrow(/symlinked parent/);
      expect(readFileSync(join(outside, "stale"), "utf8")).toBe("keep\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces an existing generated leaf symlink without following it",
    () => {
      const targetRoot = tempRoot();
      const agentsRoot = join(targetRoot, ".agents/skills");
      const outputRoot = join(targetRoot, ".opencode/skills");
      mkdirSync(agentsRoot, { recursive: true });
      mkdirSync(outputRoot, { recursive: true });
      const oldTarget = join(agentsRoot, "old");
      const newTarget = join(agentsRoot, "new");
      mkdirSync(oldTarget);
      mkdirSync(newTarget);
      const output = join(outputRoot, "skill");
      symlinkSync(relative(outputRoot, oldTarget), output, "dir");

      applyOutputs({
        ...emptyPlan(targetRoot),
        symlinks: [{ path: output, target: newTarget }],
      });

      expect(readlinkSync(output)).toBe(relative(outputRoot, newTarget));
      expect(existsSync(oldTarget)).toBe(true);
    },
  );
});
