// neo-autofix-pr --check without a readable token points at sudo neo-autofix-check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noTokenMessage, checkMode } from "../../scripts/autofix/pr-wrapper.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-tokmsg-"));

test("missing token file: says missing and names sudo neo-autofix-check", () => {
  const m = noTokenMessage(path.join(tmp, "nope"));
  assert.match(m, /missing/);
  assert.match(m, /sudo neo-autofix-check/);
});

test("unreadable token dir (non-root): not readable by this user → sudo neo-autofix-check", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
  const d = path.join(tmp, "priv");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "github-token"), "x");
  fs.chmodSync(d, 0o000);
  try {
    const m = noTokenMessage(path.join(d, "github-token"));
    assert.match(m, /not readable by this user/);
    assert.match(m, /sudo neo-autofix-check/);
  } finally {
    fs.chmodSync(d, 0o700);
  }
});

test("checkMode carries the hint", async () => {
  const r = await checkMode({ OPS_PR_TOKEN_FILE: path.join(tmp, "nope"), OPS_TARGETS: "[]" });
  assert.equal(r.code, 4);
  assert.match(r.out.messages[0], /sudo neo-autofix-check/);
});
