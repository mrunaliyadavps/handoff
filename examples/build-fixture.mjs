// Builds the example fixtures from examples/checkout/design.html:
//   design.json        Figma REST node JSON for the frame as handed off (with the usual mistakes)
//   design-fixed.json  the same frame after the designer fixed what lint reported
//   variables.json     Figma REST variables (GET /v1/files/:key/variables/local)
//   reference.png      the fixed frame exported at 1x, used by `handoff verify`
// Real projects get these from `handoff pull <figma-url>` or the Figma MCP server instead.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "checkout");

const TOKENS = {
  "color/bg": "#ffffff", "color/surface": "#f6f6f8", "color/ink": "#111113", "color/muted": "#5f5f68",
  "color/brand": "#4b3fd6", "color/brand-ink": "#ffffff", "color/line": "#e4e4e8",
  "space/1": 4, "space/2": 8, "space/3": 12, "space/4": 16, "space/6": 24, "space/8": 32,
  "radius/sm": 8, "radius/md": 12, "radius/lg": 16, "radius/full": 999,
  "font-size/sm": 13, "font-size/base": 15, "font-size/lg": 18, "font-size/xl": 24,
};

const hexToFigma = (hex) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 });

function variablesJson() {
  const collectionId = "VariableCollectionId:1:0", modeId = "1:0";
  const variables = {};
  Object.entries(TOKENS).forEach(([name, value], i) => {
    const id = `VariableID:1:${i + 1}`;
    const isColor = typeof value === "string";
    variables[id] = { id, name, key: `k${i}`, variableCollectionId: collectionId, resolvedType: isColor ? "COLOR" : "FLOAT", valuesByMode: { [modeId]: isColor ? hexToFigma(value) : value }, remote: false, scopes: ["ALL_SCOPES"] };
  });
  return { status: 200, error: false, meta: { variableCollections: { [collectionId]: { id: collectionId, name: "Checkout tokens", modes: [{ modeId, name: "Light" }], defaultModeId: modeId, variableIds: Object.keys(variables) } }, variables } };
}

async function snapshot(page, fixed) {
  const tokenIds = Object.fromEntries(Object.keys(TOKENS).map((n, i) => [n, `VariableID:1:${i + 1}`]));
  return page.evaluate(({ fixed, TOKENS, tokenIds }) => {
    const hex = (c) => { const m = c.match(/\d+(\.\d+)?/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); if (a === 0) return null; return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""); };
    const fig = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });
    const byValue = Object.fromEntries(Object.entries(TOKENS).filter(([, v]) => typeof v === "string").map(([k, v]) => [v, k]));
    let n = 0;
    const paint = (h, el, explicit) => {
      const p = { blendMode: "NORMAL", type: "SOLID", color: fig(h) };
      // Bound when the layer is linked to a variable and still uses its value. The fixed file links every colour.
      const name = explicit && TOKENS[explicit] === h ? explicit : fixed ? byValue[h] : null;
      if (name) p.boundVariables = { color: { type: "VARIABLE_ALIAS", id: tokenIds[name] } };
      return p;
    };
    const build = (el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      let type = el.dataset.type;
      const node = { id: `2:${++n}`, name: el.dataset.node, type: type === "TEXT-FRAME" ? "FRAME" : type, absoluteBoundingBox: { x: r.x, y: r.y, width: r.width, height: r.height } };
      const bind = el.dataset.bind || (fixed ? el.dataset.bindFixed : null);
      if (type === "TEXT") {
        node.characters = el.textContent.trim();
        node.style = { fontFamily: "Inter", fontWeight: Number(cs.fontWeight), fontSize: parseFloat(cs.fontSize), lineHeightPx: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 };
        node.fills = [paint(hex(cs.color), el, bind)];
        return node;
      }
      const bg = hex(cs.backgroundColor);
      node.fills = bg ? [paint(bg, el, bind)] : [];
      if (parseFloat(cs.borderTopWidth) > 0) { node.strokes = [paint(hex(cs.borderTopColor), el, null)]; node.strokeWeight = parseFloat(cs.borderTopWidth); }
      const rad = parseFloat(cs.borderTopLeftRadius); if (rad) node.cornerRadius = rad;
      if (el.dataset.reactive !== undefined) node.reactions = [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE" }] }];
      const layout = el.dataset.layout || (fixed && el.dataset.absolute !== undefined ? "HORIZONTAL" : null);
      if (layout) {
        Object.assign(node, { layoutMode: layout, itemSpacing: parseFloat(cs.columnGap || cs.gap) || parseFloat(cs.rowGap) || 0, paddingTop: parseFloat(cs.paddingTop), paddingRight: parseFloat(cs.paddingRight), paddingBottom: parseFloat(cs.paddingBottom), paddingLeft: parseFloat(cs.paddingLeft) });
      } else node.layoutMode = "NONE";
      const kids = [...el.children].filter((c) => c.dataset.node);
      if (type === "TEXT-FRAME") kids.length || (node.children = [{ id: `2:${++n}`, name: "Label", type: "TEXT", characters: el.textContent.trim(), absoluteBoundingBox: node.absoluteBoundingBox, style: { fontFamily: "Inter", fontWeight: Number(cs.fontWeight), fontSize: parseFloat(cs.fontSize) }, fills: [paint(hex(cs.color), el, bind)] }]);
      else if (kids.length) node.children = kids.map(build);
      else if (el.textContent.trim()) node.children = [{ id: `2:${++n}`, name: "Label", type: "TEXT", characters: el.textContent.trim(), absoluteBoundingBox: node.absoluteBoundingBox, style: { fontFamily: "Inter", fontWeight: Number(cs.fontWeight), fontSize: parseFloat(cs.fontSize) }, fills: [paint(hex(cs.color), el, null)] }];
      return node;
    };
    return build(document.querySelector("[data-node]"));
  }, { fixed, TOKENS, tokenIds });
}

function buttonSet(fixed) {
  const states = ["Default", "Hover", "Pressed", ...(fixed ? ["Focus", "Disabled"] : [])];
  return { id: "3:1", name: "Button", type: "COMPONENT_SET", children: states.map((s, i) => ({ id: `3:${i + 2}`, name: `State=${s}`, type: "COMPONENT" })) };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
for (const fixed of [false, true]) {
  await page.goto(pathToFileURL(path.join(dir, "design.html")).href);
  await page.evaluate((f) => document.documentElement.classList.toggle("flawed", !f), fixed);
  const frame = await snapshot(page, fixed);
  const doc = { name: "Handoff demo: checkout", lastModified: "2026-11-18T00:00:00Z", nodes: { "2:1": { document: frame }, "3:1": { document: buttonSet(fixed) } } };
  fs.writeFileSync(path.join(dir, fixed ? "design-fixed.json" : "design.json"), JSON.stringify(doc, null, 2));
  if (fixed) await page.screenshot({ path: path.join(dir, "reference.png") });
}
fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify(variablesJson(), null, 2));
await browser.close();
console.log("Wrote design.json, design-fixed.json, variables.json, reference.png");
