// Read-only. Run through the Figma MCP server's use_figma tool to export a frame
// in the same shape as the REST API, so `handoff lint` works without a Figma token.
// Replace NODE_ID below with the frame's id (from the URL: node-id=12-34 → "12:34").
// Save the returned JSON as .handoff/design.json.

const NODE_ID = "NODE_ID";

const root = await figma.getNodeByIdAsync(NODE_ID);
if (!root) throw new Error(`No node ${NODE_ID} in this file`);

const num = (v) => (typeof v === "number" ? v : undefined); // figma.mixed is a symbol
const paints = (list) =>
  Array.isArray(list)
    ? list.map((p) => ({
        type: p.type,
        visible: p.visible,
        opacity: p.opacity,
        color: p.color ? { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 } : undefined,
        boundVariables: p.boundVariables && p.boundVariables.color ? { color: { type: "VARIABLE_ALIAS", id: p.boundVariables.color.id } } : undefined,
      }))
    : [];

let count = 0;
function walk(n) {
  if (++count > 4000) throw new Error("Frame has more than 4000 layers; export a smaller frame");
  const out = { id: n.id, name: n.name, type: n.type, visible: n.visible };
  if ("absoluteBoundingBox" in n && n.absoluteBoundingBox) out.absoluteBoundingBox = n.absoluteBoundingBox;
  if ("opacity" in n) out.opacity = n.opacity;
  if ("fills" in n) {
    out.fills = paints(n.fills);
    if (typeof n.fillStyleId === "string" && n.fillStyleId) out.styles = { ...(out.styles || {}), fill: n.fillStyleId };
  }
  if ("strokes" in n) {
    out.strokes = paints(n.strokes);
    if (typeof n.strokeStyleId === "string" && n.strokeStyleId) out.styles = { ...(out.styles || {}), stroke: n.strokeStyleId };
  }
  if ("cornerRadius" in n && num(n.cornerRadius)) out.cornerRadius = n.cornerRadius;
  if ("layoutMode" in n) {
    out.layoutMode = n.layoutMode;
    if (n.layoutMode !== "NONE") Object.assign(out, { itemSpacing: n.itemSpacing, paddingTop: n.paddingTop, paddingRight: n.paddingRight, paddingBottom: n.paddingBottom, paddingLeft: n.paddingLeft });
  }
  if ("reactions" in n && n.reactions && n.reactions.length) out.reactions = n.reactions.map((r) => ({ trigger: r.trigger ? { type: r.trigger.type } : null }));
  if (n.boundVariables && Object.keys(n.boundVariables).length) {
    out.boundVariables = {};
    for (const [k, v] of Object.entries(n.boundVariables)) out.boundVariables[k] = Array.isArray(v) ? v.map((x) => ({ type: "VARIABLE_ALIAS", id: x.id })) : { type: "VARIABLE_ALIAS", id: v.id };
  }
  if (n.type === "TEXT") {
    out.characters = n.characters.slice(0, 200);
    const seg = n.getStyledTextSegments(["fontSize", "fontWeight", "fontName"])[0] || {};
    out.style = { fontSize: num(n.fontSize) ?? seg.fontSize, fontWeight: num(n.fontWeight) ?? seg.fontWeight, fontFamily: seg.fontName ? seg.fontName.family : undefined };
    if (typeof n.textStyleId === "string" && n.textStyleId) out.styles = { ...(out.styles || {}), text: n.textStyleId };
  }
  if ("children" in n) out.children = n.children.map(walk); // instances included, with their resolved layers
  return out;
}

const doc = walk(root);
return { nodes: { [root.id]: { document: doc } }, layers: count };
