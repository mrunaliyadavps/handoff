// Pull a frame, its PNG export and the file's variables from the Figma REST API.
// Needs a personal access token in FIGMA_TOKEN (file_content:read, file_variables:read).
// No token? Use the Figma MCP server instead; see skills/handoff/SKILL.md.

import fs from "node:fs";
import path from "node:path";

export function parseFigmaUrl(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!m) throw new Error(`Not a Figma design URL: ${url}`);
  const nodeId = (u.searchParams.get("node-id") || "").replace(/-/g, ":");
  if (!nodeId) throw new Error("The URL has no node-id. In Figma, right-click the frame and choose Copy link to selection.");
  return { fileKey: m[2] || m[1], nodeId };
}

async function api(route, token) {
  const res = await fetch(`https://api.figma.com/v1/${route}`, { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`Figma API ${res.status} on /${route}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function pull(url, { out = ".handoff", scale = 2, token = process.env.FIGMA_TOKEN } = {}) {
  if (!token) throw new Error("Set FIGMA_TOKEN to a Figma personal access token, or use the Figma MCP route in SKILL.md.");
  const { fileKey, nodeId } = parseFigmaUrl(url);
  fs.mkdirSync(out, { recursive: true });

  const nodes = await api(`files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`, token);
  fs.writeFileSync(path.join(out, "design.json"), JSON.stringify(nodes, null, 2));

  let variables = null;
  try {
    variables = await api(`files/${fileKey}/variables/local`, token);
    fs.writeFileSync(path.join(out, "variables.json"), JSON.stringify(variables, null, 2));
  } catch (e) {
    // Variables need an Enterprise seat or the file_variables:read scope. Lint still runs on the 4px grid.
    fs.writeFileSync(path.join(out, "variables.error.txt"), String(e.message));
  }

  const img = await api(`images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`, token);
  const pngUrl = img.images?.[nodeId];
  if (pngUrl) {
    const buf = Buffer.from(await (await fetch(pngUrl)).arrayBuffer());
    fs.writeFileSync(path.join(out, "reference.png"), buf);
  }
  const box = Object.values(nodes.nodes)[0]?.document?.absoluteBoundingBox;
  return { out, fileKey, nodeId, hasVariables: !!variables, scale, size: box && { width: box.width, height: box.height } };
}
