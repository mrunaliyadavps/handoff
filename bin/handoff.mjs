#!/usr/bin/env node
// handoff: Figma frame to accessible, token-correct code, and proof that it matches.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadTokens, toCss } from "../src/tokens.mjs";
import { lintDesign } from "../src/lint.mjs";
import { lintMarkdown, lintText, verifyMarkdown, verifyText } from "../src/report.mjs";

const HELP = `handoff: Figma to accessible, token-correct code, then proof it matches.

Usage
  handoff pull <figma-url>                 Save design.json, variables.json and reference.png to .handoff/
  handoff lint <design.json>               Find where the design breaks its own system
  handoff tokens <variables.json>          Print design tokens as CSS custom properties
  handoff verify <url|file.html>           Diff against the frame, scan accessibility, audit token use

Options
  --tokens <file>      Figma variables JSON or a flat token map
  --ref <file.png>     Figma frame export to diff against (verify)
  --scale <n>          Pixel ratio of the reference export, default 1
  --max-diff <0-1>     Allowed share of changed pixels, default 0.02
  --grid <px>          Spacing grid when there are no spacing tokens, default 4
  --out <dir>          Output folder, default .handoff
  --format <text|md|json>  Output format, default text
  --strict             Exit 1 on warnings too (lint)

Exit codes: 0 pass, 1 issues found, 2 usage error.`;

const { values: o, positionals: [cmd, input] } = parseArgs({
  allowPositionals: true,
  options: {
    tokens: { type: "string" }, ref: { type: "string" }, out: { type: "string", default: ".handoff" },
    format: { type: "string", default: "text" }, grid: { type: "string", default: "4" },
    scale: { type: "string", default: "1" }, "max-diff": { type: "string", default: "0.02" },
    selector: { type: "string" }, strict: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  },
});

if (o.help || !cmd) { console.log(HELP); process.exit(cmd ? 0 : 2); }
if (!input) { console.error(`handoff ${cmd}: missing input\n\n${HELP}`); process.exit(2); }

const emit = (text, md, json, file) => {
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, file), md);
  console.log(o.format === "json" ? JSON.stringify(json, null, 2) : o.format === "md" ? md : text);
};

try {
  if (cmd === "pull") {
    const { pull } = await import("../src/figma.mjs");
    const r = await pull(input, { out: o.out, scale: Number(o.scale) || 2 });
    console.log(`Saved to ${r.out}/: design.json${r.hasVariables ? ", variables.json" : ""}, reference.png (@${r.scale}x, ${r.size?.width}×${r.size?.height})`);
  } else if (cmd === "lint") {
    const tokens = loadTokens(o.tokens);
    const result = lintDesign(JSON.parse(fs.readFileSync(input, "utf8")), tokens, { grid: Number(o.grid) });
    emit(lintText(result), lintMarkdown(result), result, "lint.md");
    process.exit(result.summary.error || (o.strict && result.summary.warn) ? 1 : 0);
  } else if (cmd === "tokens") {
    process.stdout.write(toCss(loadTokens(input)));
  } else if (cmd === "verify") {
    const { verify } = await import("../src/verify.mjs");
    const r = await verify(input, { ref: o.ref, tokens: o.tokens ? loadTokens(o.tokens) : null, out: o.out, scale: Number(o.scale), maxDiff: Number(o["max-diff"]), selector: o.selector });
    emit(verifyText(r), verifyMarkdown(r), r, "report.md");
    process.exit(r.pass.all ? 0 : 1);
  } else {
    console.error(`Unknown command "${cmd}"\n\n${HELP}`);
    process.exit(2);
  }
} catch (e) {
  console.error(`handoff ${cmd}: ${e.message}`);
  process.exit(2);
}
