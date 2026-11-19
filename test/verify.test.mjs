import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTokens } from "../src/tokens.mjs";
import { verify } from "../src/verify.mjs";

const ex = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "checkout");
const tokens = loadTokens(path.join(ex, "variables.json"));
const run = (file) => verify(path.join(ex, file), { ref: path.join(ex, "reference.png"), tokens, out: path.join(os.tmpdir(), "handoff-" + file) });

test("a faithful build passes every check", async () => {
  const r = await run("good.html");
  assert.equal(r.pass.all, true, JSON.stringify(r.tokenAudit.violations));
  assert.ok(r.visual.mismatch < 0.02);
});

test("a build that only looks right fails, and says why", async () => {
  const r = await run("drifted.html");
  assert.equal(r.pass.tokens, false);
  assert.equal(r.pass.a11y, false);
  assert.ok(r.tokenAudit.violations.some((v) => v.value === "#4a3fd5"), "brand colour one shade off");
  assert.ok(r.tokenAudit.violations.some((v) => v.kind === "radius" && v.value === "10px"));
  assert.ok(r.fakeControls.some((f) => f.label.startsWith("Pay")), "pay button is a div");
  assert.ok(r.targets.some((t) => t.width <= 20), "20px close control");
});
