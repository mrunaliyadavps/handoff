// Load design tokens and sort them into the groups the linter and verifier need.
//
// Accepts either:
//  - the Figma REST response from GET /v1/files/:key/variables/local, or
//  - a flat map such as { "color/brand": "#2b50e0", "space/4": 16, "radius/md": 12 }.

import fs from "node:fs";
import { figmaToHex, parseColor, toHex } from "./color.mjs";

const GROUPS = {
  spacing: /(^|\/|-)(space|spacing|gap|padding|margin|inset|size\/spacing)/i,
  radius: /(radius|corner|rounded)/i,
  fontSize: /(font[-/ ]?size|text[-/ ]?size|type|typography|fontsize)/i,
};

export function loadTokens(file) {
  if (!file) return emptyTokens();
  return normaliseTokens(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function emptyTokens() {
  return { colors: new Map(), spacing: new Set(), radius: new Set(), fontSize: new Set(), byId: new Map(), source: "none" };
}

export function normaliseTokens(raw) {
  const t = emptyTokens();
  if (raw?.meta?.variables) {
    t.source = "figma-variables";
    const vars = raw.meta.variables;
    const collections = raw.meta.variableCollections || {};
    for (const [id, v] of Object.entries(vars)) {
      const coll = collections[v.variableCollectionId];
      const mode = coll?.defaultModeId ?? Object.keys(v.valuesByMode || {})[0];
      let value = v.valuesByMode?.[mode];
      // follow aliases one level at a time
      for (let hops = 0; value && value.type === "VARIABLE_ALIAS" && hops < 8; hops++) {
        const target = vars[value.id];
        if (!target) break;
        const tColl = collections[target.variableCollectionId];
        value = target.valuesByMode?.[tColl?.defaultModeId ?? Object.keys(target.valuesByMode)[0]];
      }
      add(t, v.name, v.resolvedType, value, id);
    }
  } else if (raw && typeof raw === "object") {
    t.source = "token-map";
    for (const [name, value] of Object.entries(flatten(raw))) {
      const type = typeof value === "number" ? "FLOAT" : parseColor(value) ? "COLOR" : "STRING";
      add(t, name, type, value, name);
    }
  }
  return t;
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}/${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !("r" in v) && !("$value" in v)) flatten(v, key, out);
    else out[key] = v && typeof v === "object" && "$value" in v ? v.$value : v;
  }
  return out;
}

function add(t, name, type, value, id) {
  if (value === undefined || value === null) return;
  if (type === "COLOR") {
    const hex = typeof value === "object" && "r" in value ? figmaToHex(value) : toHex(parseColor(value));
    t.colors.set(hex, [...(t.colors.get(hex) || []), name]);
    t.byId.set(id, { name, type, hex });
    return;
  }
  // Figma MCP's get_variable_defs returns text styles as "Font(family: "Inter", style: Bold, size: 18, ...)".
  const font = typeof value === "string" && value.match(/^Font\(.*?\bsize:\s*([\d.]+)/);
  if (font) {
    t.fontSize.add(Number(font[1]));
    t.byId.set(id, { name, type: "FLOAT", value: Number(font[1]) });
    return;
  }
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (Number.isNaN(num)) return;
  t.byId.set(id, { name, type, value: num });
  if (GROUPS.radius.test(name)) t.radius.add(num);
  else if (GROUPS.fontSize.test(name)) t.fontSize.add(num);
  else if (GROUPS.spacing.test(name)) t.spacing.add(num);
}

/** Name of the token for a hex colour, if any. */
export function colorTokenName(tokens, hex) {
  return tokens.colors.get(hex.toLowerCase())?.[0] ?? null;
}

/** CSS custom properties, so the agent writes var(--color-brand) instead of hex values. */
export function toCss(tokens) {
  const lines = [];
  const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const { name, type, hex, value } of tokens.byId.values()) {
    if (type === "COLOR") lines.push(`  --${slug(name)}: ${hex};`);
    else if (typeof value === "number") lines.push(`  --${slug(name)}: ${value}px;`);
  }
  return `:root {\n${[...new Set(lines)].join("\n")}\n}\n`;
}
