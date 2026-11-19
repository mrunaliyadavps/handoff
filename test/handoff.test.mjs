import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contrast, parseColor, figmaToHex } from "../src/color.mjs";
import { loadTokens, normaliseTokens, toCss } from "../src/tokens.mjs";
import { lintDesign } from "../src/lint.mjs";
import { parseFigmaUrl } from "../src/figma.mjs";

const ex = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "checkout");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ex, f), "utf8"));
const tokens = loadTokens(path.join(ex, "variables.json"));

test("contrast matches WCAG reference values", () => {
  assert.equal(contrast(parseColor("#000"), parseColor("#fff")).toFixed(1), "21.0");
  assert.equal(contrast(parseColor("#767676"), parseColor("#fff")).toFixed(2), "4.54");
  assert.equal(figmaToHex({ r: 1, g: 0.5, b: 0 }), "#ff8000");
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
});

test("Figma variables are grouped into colours, spacing, radius and type", () => {
  assert.equal(tokens.source, "figma-variables");
  assert.ok(tokens.colors.has("#4b3fd6"));
  assert.deepEqual([...tokens.spacing].sort((a, b) => a - b), [4, 8, 12, 16, 24, 32]);
  assert.ok(tokens.radius.has(12) && tokens.fontSize.has(18));
  assert.match(toCss(tokens), /--color-brand: #4b3fd6;/);
});

test("flat token maps and Figma MCP variable output both load", () => {
  const t = normaliseTokens({ color: { brand: "#4B3FD6" }, "space/4": "16", "Heading/L": 'Font(family: "Inter", style: Bold, size: 24, weight: 700, lineHeight: 32)' });
  assert.ok(t.colors.has("#4b3fd6"));
  assert.ok(t.spacing.has(16));
  assert.ok(t.fontSize.has(24));
});

test("lint finds the planted mistakes in the handed-off frame", () => {
  const { issues, summary } = lintDesign(read("design.json"), tokens);
  const has = (rule, name) => issues.some((i) => i.rule === rule && i.node.name === name);
  assert.ok(has("small-target", "Close button"), "20px close button");
  assert.ok(has("small-target", "Apply link"), "20px tall link");
  assert.ok(has("low-contrast", "Promo hint"), "2.56:1 grey text");
  assert.ok(has("off-palette-color", "Pay button"), "#4a3fd5, one shade off the brand token");
  assert.ok(has("off-grid-spacing", "Order summary"), "18px padding");
  assert.ok(has("off-scale-type", "Total"), "17px text");
  assert.ok(has("off-scale-radius", "Pay button"), "10px radius");
  assert.ok(has("missing-states", "Button"), "no focus or disabled variant");
  assert.ok(has("no-auto-layout", "Payment methods"));
  assert.equal(summary.error, 5);
});

test("lint suggests a token that actually passes contrast", () => {
  const { issues } = lintDesign(read("design.json"), tokens);
  const fix = issues.find((i) => i.rule === "low-contrast").fix;
  assert.match(fix, /color\/muted/);
});

test("lint passes the fixed frame", () => {
  const { issues } = lintDesign(read("design-fixed.json"), tokens);
  assert.deepEqual(issues, []);
});

test("Figma URLs resolve to file key and node id", () => {
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC123/Checkout?node-id=12-34&t=x"), { fileKey: "AbC123", nodeId: "12:34" });
  assert.deepEqual(parseFigmaUrl("https://figma.com/design/AbC123/branch/XyZ9/Checkout?node-id=1-2").fileKey, "XyZ9");
  assert.throws(() => parseFigmaUrl("https://figma.com/design/AbC123/Checkout"), /node-id/);
});

test("extract-figma.js turns Plugin API nodes into lintable JSON", async () => {
  const src = fs.readFileSync(path.join(ex, "..", "..", "skills", "handoff", "extract-figma.js"), "utf8").replace('"NODE_ID";', '"1:1";');
  const mixed = Symbol("mixed");
  const base = { visible: true, opacity: 1, strokes: [], fillStyleId: "", strokeStyleId: "", boundVariables: {}, reactions: [] };
  const label = { ...base, id: "1:3", name: "Label", type: "TEXT", absoluteBoundingBox: { x: 24, y: 640, width: 80, height: 20 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 1, g: 1, b: 1 } }], characters: "Pay", fontSize: 18, fontWeight: 700, textStyleId: "", getStyledTextSegments: () => [{ fontName: { family: "Inter", style: "Bold" } }] };
  const close = { ...base, id: "1:4", name: "Close button", type: "INSTANCE", absoluteBoundingBox: { x: 340, y: 24, width: 20, height: 20 }, fills: [], cornerRadius: mixed, layoutMode: "NONE", reactions: [{ trigger: { type: "ON_CLICK" } }], children: [] };
  const pay = { ...base, id: "1:2", name: "Pay button", type: "INSTANCE", absoluteBoundingBox: { x: 24, y: 640, width: 342, height: 52 }, fills: [{ type: "SOLID", visible: true, opacity: 1, color: { r: 75 / 255, g: 63 / 255, b: 214 / 255 } }], cornerRadius: 12, layoutMode: "HORIZONTAL", itemSpacing: 8, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, children: [label] };
  const frame = { ...base, id: "1:1", name: "Checkout", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 720 }, fills: [], cornerRadius: 0, layoutMode: "VERTICAL", itemSpacing: 24, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, children: [close, pay] };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const out = await new AsyncFunction("figma", src)({ getNodeByIdAsync: async (id) => (id === "1:1" ? frame : null), mixed });
  assert.equal(out.layers, 4);
  const { issues } = lintDesign(out, tokens);
  assert.ok(issues.some((i) => i.rule === "small-target" && i.node.name === "Close button"));
  assert.ok(issues.some((i) => i.rule === "unbound-color" && i.node.name === "Pay button"), "brand colour not linked to its variable");
});
