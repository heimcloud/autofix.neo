/**
 * Lab runner build env (v0.3.2): the host config repo belongs to its owner,
 * the runner is root, and Nix/libgit2 refuse it ("not owned by current
 * user"). nixEnv() trusts exactly that path through a runner-private HOME;
 * never "*", never the real global gitconfig. The ownership mismatch is
 * simulated with git's GIT_TEST_ASSUME_DIFFERENT_OWNER (same safe.directory
 * semantics as libgit2, which only reads $HOME/.gitconfig + XDG/system).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { nixEnv, gitSafePath } = await import("../../scripts/autofix/labtest.mjs");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lab-git-safe-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const realHome = path.join(tmp, "root-home");
fs.mkdirSync(realHome);
const base = { PATH: process.env.PATH, HOME: realHome, GIT_CONFIG_NOSYSTEM: "1" };
function repo(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  const g = (...a) => spawnSync("git", a, { cwd: d, env: { ...base, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q");
  fs.writeFileSync(path.join(d, "flake.nix"), "{ outputs = _: { }; }\n");
  g("add", ".");
  g("commit", "-qm", "i");
  return d;
}
const config = repo("configuration");
const other = repo("other");
const opened = (dir, env) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: { ...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }, encoding: "utf8" });

test("ownership mismatch: refused without the runner env, opened with it, only for the config repo", () => {
  const plain = opened(config, base);
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /dubious ownership|not owned/);

  const cfg = { flake: config, stateDir: path.join(tmp, "state") };
  const env = nixEnv(cfg, base);
  assert.equal(opened(config, env).status, 0, opened(config, env).stderr);
  assert.notEqual(opened(other, env).status, 0, "a different repo stays refused");

  const safe = spawnSync("git", ["config", "--global", "--get-all", "safe.directory"], { env, encoding: "utf8" }).stdout.trim().split("\n");
  assert.deepEqual(safe, [config]);
  assert.ok(!safe.includes("*"));
  assert.equal(env.HOME, path.join(tmp, "state", "git-home"));
  assert.equal(fs.statSync(env.HOME).mode & 0o777, 0o700);
  assert.equal(env.XDG_CONFIG_HOME, path.join(realHome, ".config"), "nix.conf / tokens of the real home stay in use");
  assert.equal(env.XDG_CACHE_HOME, path.join(realHome, ".cache"));
  assert.equal(fs.existsSync(path.join(realHome, ".gitconfig")), false, "the real global gitconfig is never written");
  // Idempotent, and the env of the runner process itself is untouched.
  assert.deepEqual(nixEnv(cfg, base), env);
  assert.equal(base.HOME, realHome);
});

test("safe.directory value: resolved path only, no wildcard or gitconfig syntax", () => {
  assert.equal(gitSafePath(config), config);
  for (const bad of ["/", "*", "/tmp/a*", '/tmp/a"b', "/tmp/a\nb", "/tmp/a#b"]) assert.throws(() => gitSafePath(bad), /refusing/);
});
