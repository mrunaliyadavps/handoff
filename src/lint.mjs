// Design lint: find the places where a Figma frame breaks its own design system,
// before an agent turns those mistakes into code.
//
// Input is Figma node JSON in the REST API shape (GET /v1/files/:key/nodes),
// or the same shape produced inside Figma by skills/handoff/extract-figma.js.

import { contrast, distance, figmaToHex, flatten, parseColor } from "./color.mjs";
import { colorTokenName } from "./tokens.mjs";

export const RULES = {
  "off-palette-color": "Colour is not one of the design's colour tokens",
  "unbound-color": "Colour matches a token value but is not linked to the variable",
  "off-grid-spacing": "Auto layout spacing or padding is off the spacing scale",
  "off-scale-radius": "Corner radius is not one of the radius tokens",
  "off-scale-type": "Font size is not in the type scale",
  "low-contrast": "Text does not meet WCAG AA contrast against its background",
  "small-target": "Interactive element is smaller than the minimum target size",
  "missing-states": "Component set has no focus or disabled state",
  "no-auto-layout": "Frame with several children uses absolute positioning",
};

const INTERACTIVE = /\b(button|btn|cta|link|tab|toggle|switch|checkbox|radio|chip|icon[- ]?button|input|field|select|close)\b/i;

/**
 * @param {object} doc   Figma node JSON: a node, or a REST response with .nodes
 * @param {object} tokens  from loadTokens()
 * @param {object} opts  { grid: 4, target: 24, targetRecommended: 44 }
 */
export function lintDesign(doc, tokens, opts = {}) {
  const o = { grid: 4, target: 24, targetRecommended: 44, ...opts };
  const roots = rootsOf(doc);
  const issues = [];
  const push = (rule, severity, node, path, message, fix) =>
    issues.push({ rule, severity, node: { id: node.id, name: node.name, type: node.type, path: path.join(" › ") }, message, fix });

  const hasColorTokens = tokens.colors.size > 0;
  const spacing = tokens.spacing.size ? [...tokens.spacing] : null;
  const radii = tokens.radius.size ? [...tokens.radius] : null;
  const typeScale = tokens.fontSize.size ? [...tokens.fontSize] : null;

  function walk(node, path, bgStack) {
    if (node.visible === false) return;
    const here = [...path, node.name];

    // background for contrast checks: nearest opaque-ish solid fill above the text
    const ownFill = solidFills(node).at(-1);
    const bg = ownFill && node.type !== "TEXT" ? flatten(ownFill.rgb, bgStack.at(-1)) : null;
    const nextBg = bg ? [...bgStack, bg] : bgStack;

    // 1-2. colours
    for (const [kind, paints] of [["fill", node.fills], ["stroke", node.strokes]]) {
      if (!Array.isArray(paints)) continue;
      paints.forEach((p, idx) => {
        if (p.type !== "SOLID" || p.visible === false) return;
        const hex = figmaToHex(p.color);
        const bound = p.boundVariables?.color || node.boundVariables?.[kind + "s"]?.[idx] || node.styles?.[kind];
        if (!hasColorTokens || bound) return;
        const name = colorTokenName(tokens, hex);
        if (name) {
          push("unbound-color", "warn", node, here, `${kind} ${hex} equals token "${name}" but is not linked to it`, `Bind the ${kind} to the "${name}" variable so a theme change reaches it.`);
        } else {
          let near = nearestColor(tokens, hex);
          if (node.type === "TEXT" && kind === "fill") {
            const under = nextBg.at(-1), size = node.style?.fontSize ?? 16;
            const need = size >= 24 || ((node.style?.fontWeight ?? 400) >= 700 && size >= 18.66) ? 3 : 4.5;
            near = passingToken(tokens, parseColor(hex), under, need) ?? near;
          }
          push("off-palette-color", "error", node, here, `${kind} ${hex} is not in the palette`, near ? `Closest token is "${near.name}" (${near.hex}).` : "Add it to the palette or use an existing colour.");
        }
      });
    }

    // 3. spacing on auto layout frames
    if (node.layoutMode && node.layoutMode !== "NONE") {
      const props = { gap: node.itemSpacing, "padding-top": node.paddingTop, "padding-right": node.paddingRight, "padding-bottom": node.paddingBottom, "padding-left": node.paddingLeft };
      for (const [prop, val] of Object.entries(props)) {
        if (typeof val !== "number" || val === 0) continue;
        const ok = spacing ? spacing.includes(val) : val % o.grid === 0;
        if (!ok) push("off-grid-spacing", "warn", node, here, `${prop} is ${val}px`, spacing ? `Nearest step on the spacing scale is ${nearest(spacing, val)}px.` : `Use a multiple of ${o.grid}px, for example ${Math.round(val / o.grid) * o.grid}px.`);
      }
    } else if (["FRAME", "COMPONENT", "INSTANCE"].includes(node.type) && (node.children?.length ?? 0) >= 3 && path.length > 0) {
      push("no-auto-layout", "info", node, here, `${node.children.length} children positioned by hand`, "Use auto layout so the agent can build it with flex or grid instead of absolute positions.");
    }

    // 4. radius
    const r = node.cornerRadius;
    if (radii && typeof r === "number" && r > 0 && !radii.includes(r) && !node.boundVariables?.topLeftRadius) {
      push("off-scale-radius", "warn", node, here, `corner radius is ${r}px`, `Nearest radius token is ${nearest(radii, r)}px.`);
    }

    // 5-6. text: type scale and contrast
    if (node.type === "TEXT") {
      const size = node.style?.fontSize;
      if (typeScale && size && !typeScale.includes(size) && !node.styles?.text) {
        push("off-scale-type", "warn", node, here, `font size ${size}px is not in the type scale`, `Nearest size is ${nearest(typeScale, size)}px, or apply a text style.`);
      }
      const fg = solidFills(node).at(-1);
      if (fg && size) {
        const under = nextBg.at(-1);
        const ratio = contrast(flatten(fg.rgb, under), under);
        const bold = (node.style?.fontWeight ?? 400) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : 4.5;
        if (ratio < need) {
          const pass = passingToken(tokens, fg.rgb, under, need);
          const fix = pass ? `Use "${pass.name}" (${pass.hex}), which reaches ${pass.ratio.toFixed(1)}:1 here.` : `Darken or lighten the text until it reaches ${need}:1.`;
          push("low-contrast", "error", node, here, `contrast ${ratio.toFixed(2)}:1, needs ${need}:1 (${large ? "large" : "body"} text, ${size}px)`, fix);
        }
      }
    }

    // 7. target size
    const box = node.absoluteBoundingBox;
    const interactive = (node.reactions?.length ?? 0) > 0 || INTERACTIVE.test(node.name);
    if (interactive && box && node.type !== "TEXT" && !isInsideInteractive(path)) {
      const min = Math.min(box.width, box.height);
      if (min < o.target) push("small-target", "error", node, here, `${Math.round(box.width)}×${Math.round(box.height)}px is below the ${o.target}px minimum (WCAG 2.5.8)`, `Grow the hit area to at least ${o.targetRecommended}×${o.targetRecommended}px.`);
      else if (min < o.targetRecommended) push("small-target", "warn", node, here, `${Math.round(box.width)}×${Math.round(box.height)}px is below the ${o.targetRecommended}px touch target`, `Grow the hit area to ${o.targetRecommended}×${o.targetRecommended}px; the visible shape can stay smaller.`);
    }

    // 8. states
    if (node.type === "COMPONENT_SET" && INTERACTIVE.test(node.name)) {
      const names = (node.children || []).map((c) => c.name.toLowerCase()).join(" | ");
      const missing = ["focus", "disabled"].filter((s) => !names.includes(s));
      if (missing.length) push("missing-states", "warn", node, here, `no ${missing.join(" or ")} variant`, `Add ${missing.join(" and ")} variants so the code has a design to follow for keyboard and disabled states.`);
    }

    for (const child of node.children || []) walk(child, here, nextBg);
  }

  for (const root of roots) walk(root, [], [{ r: 255, g: 255, b: 255, a: 1 }]);

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, summary: summarise(issues), roots: roots.map((r) => r.name) };
}

function rootsOf(doc) {
  if (doc?.nodes) return Object.values(doc.nodes).map((n) => n.document).filter(Boolean);
  if (doc?.document) return [doc.document];
  return [doc];
}

function solidFills(node) {
  return (node.fills || [])
    .filter((p) => p.type === "SOLID" && p.visible !== false)
    .map((p) => ({ rgb: { r: p.color.r * 255, g: p.color.g * 255, b: p.color.b * 255, a: (p.color.a ?? 1) * (p.opacity ?? 1) * (node.opacity ?? 1) } }));
}

function isInsideInteractive(path) {
  return path.some((n) => INTERACTIVE.test(n));
}

function nearest(list, v) {
  return list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0]);
}

/** Nearest colour token that still meets the contrast requirement on this background. */
function passingToken(tokens, fg, bg, need) {
  let best = null;
  for (const [h, names] of tokens.colors) {
    const c = parseColor(h);
    const ratio = contrast(c, bg);
    if (ratio < need) continue;
    const d = distance(fg, c);
    if (!best || d < best.d) best = { d, hex: h, name: names[0], ratio };
  }
  return best;
}

function nearestColor(tokens, hex) {
  const c = parseColor(hex);
  let best = null;
  for (const [h, names] of tokens.colors) {
    const d = distance(c, parseColor(h));
    if (!best || d < best.d) best = { d, hex: h, name: names[0] };
  }
  return best;
}

export function summarise(issues) {
  const s = { error: 0, warn: 0, info: 0, byRule: {} };
  for (const i of issues) {
    s[i.severity]++;
    s.byRule[i.rule] = (s.byRule[i.rule] || 0) + 1;
  }
  return s;
}
