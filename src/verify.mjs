// Verify: render the code the agent wrote and prove it matches the design.
//
//  1. Visual diff against the Figma frame export (pixelmatch).
//  2. Accessibility scan (axe-core, WCAG 2.2 AA).
//  3. Token audit on the rendered DOM: every colour, spacing, radius and font
//     size must come from the design tokens. Works for any framework, because
//     it reads computed styles, not source files.
//  4. Target size of every interactive element.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { distance, parseColor, toHex } from "./color.mjs";

const require = createRequire(import.meta.url);

/**
 * @param {string} target  URL or path to an HTML file
 * @param {object} o  { ref, tokens, out, width, height, threshold, maxDiff, selector }
 */
export async function verify(target, o = {}) {
  const url = /^https?:\/\//.test(target) ? target : pathToFileURL(path.resolve(target)).href;
  const out = o.out ?? ".handoff";
  fs.mkdirSync(out, { recursive: true });

  let ref = null;
  if (o.ref) ref = PNG.sync.read(fs.readFileSync(o.ref));
  const scale = o.scale ?? 1;
  const width = o.width ?? (ref ? Math.round(ref.width / scale) : 1280);
  const height = o.height ?? (ref ? Math.round(ref.height / scale) : 800);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts?.ready);
    const scope = o.selector ?? "body";

    // 1. visual diff
    let visual = null;
    const shot = await page.screenshot({ path: path.join(out, "actual.png"), clip: { x: 0, y: 0, width, height } });
    if (ref) {
      const actual = PNG.sync.read(shot);
      const w = Math.min(ref.width, actual.width), h = Math.min(ref.height, actual.height);
      const crop = (img) => { const c = new PNG({ width: w, height: h }); PNG.bitblt(img, c, 0, 0, w, h, 0, 0); return c; };
      const a = crop(ref), b = crop(actual), diff = new PNG({ width: w, height: h });
      const changed = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: o.threshold ?? 0.1, alpha: 0.25, diffColor: [255, 64, 32] });
      fs.writeFileSync(path.join(out, "diff.png"), PNG.sync.write(diff));
      visual = { changedPixels: changed, totalPixels: w * h, mismatch: changed / (w * h), sizeMatch: ref.width === actual.width && ref.height === actual.height };
    }

    // 2. accessibility
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const axe = await page.evaluate(async (sel) => {
      const r = await window.axe.run(document.querySelector(sel) || document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, url: v.helpUrl, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")), count: v.nodes.length }));
    }, scope);

    // 3 + 4. computed styles and target sizes
    const styles = await page.evaluate((sel) => {
      const root = document.querySelector(sel) || document.body;
      const pathOf = (el) => {
        const parts = [];
        for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
          let p = e.tagName.toLowerCase();
          if (e.id) { parts.unshift(p + "#" + e.id); break; }
          const cls = [...e.classList].slice(0, 2).join(".");
          parts.unshift(cls ? p + "." + cls : p);
        }
        return parts.join(" > ");
      };
      const rows = [];
      const interactive = [];
      const fake = [];
      // Browser defaults (like 1px 6px on <button>) were not written by anyone, so they are not checked.
      const blank = document.createElement("iframe");
      blank.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
      document.body.appendChild(blank);
      const defaults = {};
      const uaDefault = (tag, prop) => {
        if (!defaults[tag]) {
          const d = blank.contentDocument.createElement(tag);
          blank.contentDocument.body.appendChild(d);
          defaults[tag] = blank.contentWindow.getComputedStyle(d);
        }
        return defaults[tag][prop];
      };
      const isAuto = (el, prop) => {
        try { return String(el.computedStyleMap().get(prop)) === "auto"; } catch { return false; }
      };
      for (const el of [root, ...root.querySelectorAll("*")]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        rows.push({
          sel: pathOf(el),
          color: hasText ? cs.color : null,
          background: cs.backgroundColor,
          border: parseFloat(cs.borderTopWidth) > 0 ? cs.borderTopColor : null,
          fontSize: hasText ? parseFloat(cs.fontSize) : null,
          spacing: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginBottom", "rowGap", "columnGap"]
            .map((k) => [k, parseFloat(cs[k])])
            .filter(([k, v]) => v > 0 && Number.isFinite(v)
              && cs[k] !== uaDefault(el.tagName.toLowerCase(), k)
              && !(k.startsWith("margin") && isAuto(el, k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())))),
          radius: parseFloat(cs.borderTopLeftRadius) || 0,
        });
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        if (["a", "button", "select", "textarea"].includes(tag) || (tag === "input" && el.type !== "hidden") || ["button", "link", "checkbox", "radio", "switch", "tab"].includes(role)) {
          interactive.push({ sel: pathOf(el), width: Math.round(r.width), height: Math.round(r.height), label: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40) });
        } else if ((el.hasAttribute("onclick") || cs.cursor === "pointer") && !el.closest("a,button,[role]") && el.tabIndex < 0) {
          // Looks clickable but a keyboard or screen reader cannot reach it. axe does not catch this.
          const item = { sel: pathOf(el), width: Math.round(r.width), height: Math.round(r.height), label: (el.innerText || "").trim().slice(0, 40) };
          fake.push(item);
          interactive.push(item);
        }
      }
      blank.remove();
      return { rows, interactive, fake };
    }, scope);

    const tokenAudit = auditTokens(styles.rows, o.tokens);
    const targets = styles.interactive
      .filter((t) => Math.min(t.width, t.height) < 44)
      .map((t) => ({ ...t, severity: Math.min(t.width, t.height) < 24 ? "error" : "warn" }));

    const maxDiff = o.maxDiff ?? 0.02;
    const pass = {
      visual: visual ? visual.mismatch <= maxDiff : null,
      a11y: axe.filter((v) => ["serious", "critical"].includes(v.impact)).length === 0 && styles.fake.length === 0,
      tokens: tokenAudit.violations.length === 0,
      targets: targets.filter((t) => t.severity === "error").length === 0,
    };
    pass.all = Object.values(pass).every((v) => v !== false);
    const result = { target, viewport: { width, height }, visual, axe, fakeControls: styles.fake, tokenAudit, targets, pass, out };
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await browser.close();
  }
}

const transparent = (c) => !c || c.a === 0;

export function auditTokens(rows, tokens) {
  const violations = [];
  if (!tokens || (tokens.colors.size + tokens.spacing.size + tokens.radius.size + tokens.fontSize.size) === 0) {
    return { checked: 0, violations, note: "No tokens given, so values were not checked." };
  }
  const seen = new Map();
  const flag = (kind, value, sel, hint) => {
    const key = kind + "|" + value;
    if (!seen.has(key)) { seen.set(key, { kind, value, hint, where: [] }); violations.push(seen.get(key)); }
    const v = seen.get(key);
    if (v.where.length < 3) v.where.push(sel);
  };
  const colorHex = new Set([...tokens.colors.keys()]);
  let checked = 0;
  for (const r of rows) {
    if (colorHex.size) {
      for (const [kind, raw] of [["color", r.color], ["background", r.background], ["border", r.border]]) {
        const c = parseColor(raw);
        if (transparent(c)) continue;
        checked++;
        const hex = toHex(c);
        if (!colorHex.has(hex)) {
          const near = [...tokens.colors].map(([h, names]) => ({ h, name: names[0], d: distance(c, parseColor(h)) })).sort((a, b) => a.d - b.d)[0];
          flag(kind, hex, r.sel, `Closest token is "${near.name}" (${near.h}).`);
        }
      }
    }
    if (tokens.spacing.size) {
      const allowed = new Set([0, ...tokens.spacing]);
      for (const [prop, v] of r.spacing) {
        checked++;
        if (!allowed.has(Math.round(v * 100) / 100)) flag("spacing", `${v}px`, `${r.sel} (${prop})`, `Closest spacing token is ${closest([...tokens.spacing], v)}px.`);
      }
    }
    if (tokens.radius.size && r.radius > 0) {
      checked++;
      const allowed = new Set([...tokens.radius]);
      if (!allowed.has(r.radius) && r.radius < 999) flag("radius", `${r.radius}px`, r.sel, `Closest radius token is ${closest([...tokens.radius], r.radius)}px.`);
    }
    if (tokens.fontSize.size && r.fontSize) {
      checked++;
      if (!tokens.fontSize.has(r.fontSize)) flag("font-size", `${r.fontSize}px`, r.sel, `Closest size in the type scale is ${closest([...tokens.fontSize], r.fontSize)}px.`);
    }
  }
  return { checked, violations };
}

function closest(list, v) {
  return list.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), list[0]);
}
