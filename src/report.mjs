// Human-readable reports: Markdown for pull requests and agents, coloured text for terminals.

const ICON = { error: "✖", warn: "▲", info: "●" };

export function lintMarkdown(result) {
  const { issues, summary, roots } = result;
  const lines = [`## Design lint: ${roots.join(", ")}`, ""];
  if (!issues.length) return [...lines, "No issues. The design follows its own system.", ""].join("\n");
  lines.push(`**${summary.error} errors · ${summary.warn} warnings · ${summary.info} notes**`, "");
  lines.push("| | Rule | Layer | Problem | Fix |", "|---|---|---|---|---|");
  for (const i of issues) lines.push(`| ${ICON[i.severity]} | \`${i.rule}\` | ${esc(i.node.path)} | ${esc(i.message)} | ${esc(i.fix)} |`);
  lines.push("", "Decide before coding: fix these in Figma, or tell the agent to follow the design system where the frame disagrees with it.", "");
  return lines.join("\n");
}

export function verifyMarkdown(r) {
  const ok = (v) => (v === null ? "–" : v ? "✅ pass" : "❌ fail");
  const lines = [`## Handoff verify: ${r.target}`, ""];
  lines.push("| Check | Result | Detail |", "|---|---|---|");
  if (r.visual) lines.push(`| Matches the Figma frame | ${ok(r.pass.visual)} | ${(r.visual.mismatch * 100).toFixed(2)}% of pixels differ |`);
  const serious = r.axe.filter((v) => ["serious", "critical"].includes(v.impact));
  lines.push(`| Accessibility (axe, WCAG 2.2 AA) | ${ok(r.pass.a11y)} | ${serious.length} serious, ${r.axe.length - serious.length} other, ${r.fakeControls.length} clickable elements that are not controls |`);
  lines.push(`| Only design-token values | ${ok(r.pass.tokens)} | ${r.tokenAudit.violations.length} off-token values in ${r.tokenAudit.checked} checked |`);
  lines.push(`| Target sizes | ${ok(r.pass.targets)} | ${r.targets.length} below 44px |`);
  if (r.tokenAudit.violations.length) {
    lines.push("", "### Values that are not tokens", "", "| Kind | Value | Where | Fix |", "|---|---|---|---|");
    for (const v of r.tokenAudit.violations.slice(0, 25)) lines.push(`| ${v.kind} | \`${v.value}\` | ${esc(v.where.join("<br>"))} | ${esc(v.hint)} |`);
  }
  if (r.fakeControls.length) {
    lines.push("", "### Clickable but not a control", "", "These respond to a mouse but a keyboard or screen reader cannot reach them. Use <button> or <a href>.", "", "| Element | Text |", "|---|---|");
    for (const f of r.fakeControls) lines.push(`| ${esc(f.sel)} | ${esc(f.label)} |`);
  }
  if (r.axe.length) {
    lines.push("", "### Accessibility", "", "| Impact | Rule | Elements |", "|---|---|---|");
    for (const v of r.axe) lines.push(`| ${v.impact} | [${v.id}](${v.url}): ${esc(v.help)} | ${esc(v.nodes.join("<br>"))} |`);
  }
  if (r.targets.length) {
    lines.push("", "### Small targets", "", "| Size | Element |", "|---|---|");
    for (const t of r.targets) lines.push(`| ${t.width}×${t.height}px ${t.severity === "error" ? "(below 24px)" : ""} | ${esc(t.sel)} ${t.label ? `“${esc(t.label)}”` : ""} |`);
  }
  if (r.visual) lines.push("", `Diff image: \`${r.out}/diff.png\` (changed pixels in red).`);
  lines.push("");
  return lines.join("\n");
}

const C = process.stdout.isTTY ? { red: "\x1b[31m", yel: "\x1b[33m", dim: "\x1b[2m", grn: "\x1b[32m", b: "\x1b[1m", x: "\x1b[0m" } : { red: "", yel: "", dim: "", grn: "", b: "", x: "" };

export function lintText(result) {
  const { issues, summary } = result;
  if (!issues.length) return `${C.grn}✓ No design issues${C.x}`;
  const col = { error: C.red, warn: C.yel, info: C.dim };
  const out = issues.map((i) => `${col[i.severity]}${ICON[i.severity]} ${i.rule}${C.x}  ${C.b}${i.node.name}${C.x} ${C.dim}${i.node.path}${C.x}\n    ${i.message}\n    ${C.dim}→ ${i.fix}${C.x}`);
  out.push("", `${C.b}${summary.error} errors, ${summary.warn} warnings, ${summary.info} notes${C.x}  ${C.dim}(${Object.entries(summary.byRule).map(([k, n]) => `${n}× ${k}`).join(", ")})${C.x}`);
  return out.join("\n");
}

export function verifyText(r) {
  const mark = (v) => (v === null ? `${C.dim}–${C.x}` : v ? `${C.grn}✓${C.x}` : `${C.red}✖${C.x}`);
  const lines = [];
  if (r.visual) lines.push(`${mark(r.pass.visual)} Visual match   ${(r.visual.mismatch * 100).toFixed(2)}% of pixels differ`);
  lines.push(`${mark(r.pass.a11y)} Accessibility  ${r.axe.length} axe findings (${r.axe.filter((v) => ["serious", "critical"].includes(v.impact)).length} serious), ${r.fakeControls.length} clickable elements that are not controls`);
  for (const f of r.fakeControls.slice(0, 5)) lines.push(`    ${C.dim}not a control${C.x} “${f.label}”  ${C.dim}${f.sel}${C.x}`);
  lines.push(`${mark(r.pass.tokens)} Tokens only    ${r.tokenAudit.violations.length} off-token values`);
  for (const v of r.tokenAudit.violations.slice(0, 8)) lines.push(`    ${C.dim}${v.kind}${C.x} ${v.value}  ${C.dim}${v.where[0]}${C.x}`);
  lines.push(`${mark(r.pass.targets)} Target sizes   ${r.targets.length} below 44px`);
  lines.push("", r.pass.all ? `${C.grn}${C.b}PASS${C.x}` : `${C.red}${C.b}FAIL${C.x}  ${C.dim}report: ${r.out}/report.md${C.x}`);
  return lines.join("\n");
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
