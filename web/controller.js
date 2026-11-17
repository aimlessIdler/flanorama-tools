import { PROPERTY, normalizeOptions, planPacking } from "./packing.js";
import { installNodeRenderer } from "./renderer.js";

export function isNode(item) {
  return !!item && typeof item.collapse === "function" && item.pos && item.size && item.id != null;
}

export function selectionOf(canvas, fallback) {
  const items = canvas?.selectedItems ? [...canvas.selectedItems] : Object.values(canvas?.selected_nodes || {});
  // A context menu opened on an unselected node should act on that node only.
  const nodes = items.filter(isNode);
  return fallback && isNode(fallback) && !nodes.includes(fallback) ? [fallback] : nodes;
}

export function eligibleNodes(nodes, options) {
  return nodes.filter(n => (!options.skipPinned || !(n.pinned || n.flags?.pinned)) && n.constructor?.collapsable !== false && n.collapsable !== false);
}

export function graphEdges(graph) {
  const links = graph?.links;
  return (typeof links?.values === "function" ? [...links.values()] : Object.values(links || {}))
    .filter(Boolean).map(l => Array.isArray(l) ? [l[1], l[3]] : [l.origin_id, l.target_id]);
}

export function graphGroups(graph) { return graph._groups || graph.groups || []; }
function groupBounds(group) {
  return { x: group.pos[0], y: group.pos[1], width: group.size[0], height: group.size[1] };
}
function contains(group, node) {
  const b = groupBounds(group), x = node.pos[0], y = node.pos[1];
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}
export function containingGroup(graph, nodes, canvas) {
  const selected = [...(canvas?.selectedItems || [])].filter(item => graphGroups(graph).includes(item));
  const candidates = selected.length ? selected : graphGroups(graph).filter(g => nodes.every(n => contains(g, n)));
  return candidates.filter(g => !g.flags?.pinned && !g.pinned && nodes.every(n => contains(g, n)))
    .sort((a,b) => a.size[0]*a.size[1] - b.size[0]*b.size[1])[0] || null;
}

export function transaction(canvas, graph, action) {
  // Match ComfyUI's own multi-item canvas operations. The canvas events keep
  // the change tracker from capturing intermediate collapse/move operations.
  canvas.emitBeforeChange?.();
  try {
    graph.beforeChange?.();
    try { return action(); }
    finally { graph.afterChange?.(); }
  } finally { canvas.emitAfterChange?.(); canvas.setDirty?.(true, true); }
}

// Workflow snapshots contain JSON data. JSON serialization also detaches
// ComfyUI's reactive proxies, which structuredClone cannot accept (including
// proxies nested inside an otherwise plain group serialization).
function copyWorkflowData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nodeSnapshot(node) {
  return { node, pos: [...node.pos], collapsed: node.flags?.collapsed,
    property: copyWorkflowData(node.properties?.[PROPERTY]),
    color: node.color, bgcolor: node.bgcolor };
}
function restoreNode(s) {
  s.node.pos = [...s.pos];
  s.node.flags ||= {};
  if (s.collapsed === undefined) delete s.node.flags.collapsed;
  else s.node.flags.collapsed = s.collapsed;
  s.node.properties ||= {};
  if (s.property === undefined) delete s.node.properties[PROPERTY];
  else s.node.properties[PROPERTY] = s.property;
  s.node.color = s.color; s.node.bgcolor = s.bgcolor;
}
function setGroupBounds(group, bounds) {
  if (typeof group.setBounds === "function") group.setBounds(...bounds);
  else { group.pos = bounds.slice(0,2); group.size = bounds.slice(2); }
}
function sameNodes(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const left=a.map(String).sort(), right=b.map(String).sort();
  return left.every((id,i)=>id===right[i]);
}

function fitGroup(group, entries, options, grid, Group) {
  const pad = options.padding * grid;
  const header = Math.ceil(((group.font_size || 24) + 12) / grid) * grid;
  const left = Math.min(...entries.map(e=>e.x)), top = Math.min(...entries.map(e=>e.y));
  const right = Math.max(...entries.map(e=>e.x+e.width)), bottom = Math.max(...entries.map(e=>e.y+e.height));
  setGroupBounds(group, [left-pad, top-pad-header,
    Math.max(Group.minWidth || 140, right-left+pad*2), Math.max(Group.minHeight || 80, bottom-top+pad*2+header)]);
  group.recomputeInsideNodes?.();
}

export function applyPacking({ canvas, graph, nodes, options: input, metrics, litegraph, Group, bridge }) {
  if (canvas.read_only) throw new Error("This workflow is read-only.");
  const options = normalizeOptions(input);
  const eligible = eligibleNodes(nodes, options);
  if (!eligible.length) throw new Error("Select at least one movable, collapsible node.");
  if (eligible.some(n => n.graph !== graph)) throw new Error("The workflow changed. Select the nodes again.");
  const existing = options.grouping === "existing" ? containingGroup(graph, eligible, canvas) : null;
  if (options.grouping === "existing" && !existing) throw new Error("Select nodes inside one unlocked group to resize it.");
  const plan = planPacking(eligible, options, { ...metrics, edges: graphEdges(graph) });
  if (options.grouping !== "none" && typeof Group !== "function") throw new Error("This frontend does not expose workflow groups.");
  for (const n of eligible) installNodeRenderer(n, litegraph);
  const snapshots = eligible.map(nodeSnapshot);
  const originalGroups = [...graphGroups(graph)];
  const groupSnapshots = originalGroups.map(g => ({ g, data: copyWorkflowData(g.serialize()) }));
  const untouched = existing ? graph._nodes.filter(n => !eligible.includes(n) && contains(existing, n)) : [];
  const untouchedEntries = untouched.map(n => {
    const b = n.getBounding?.();
    return b ? {x:b[0],y:b[1],width:b[2],height:b[3]} : {x:n.pos[0],y:n.pos[1]-metrics.titleHeight,width:n.size[0],height:n.size[1]+metrics.titleHeight};
  });
  return transaction(canvas, graph, () => {
    try {
      for (const entry of plan.entries) {
        const n = entry.node;
        n.properties ||= {};
        n.properties[PROPERTY] = { version: 1, width: entry.width };
        if (!n.flags?.collapsed) n.collapse(true);
        if (!n.flags?.collapsed) throw new Error(`“${n.title || n.type || "This node"}” refused to collapse. The pack was cancelled.`);
        n.pos = [entry.x, entry.y + plan.titleHeight];
        if (entry.colors) { n.color = entry.colors.color; n.bgcolor = entry.colors.bgcolor; }
        n.setDirtyCanvas?.(true, true);
      }
      if (existing) fitGroup(existing, [...plan.entries, ...untouchedEntries], options, plan.grid, Group);
      else if (options.grouping !== "none") {
        const sets = options.grouping === "single" ? [{ key: "all", entries: plan.entries }] : plan.stacks;
        for (const set of sets) {
          const ids = set.entries.map(e=>String(e.node.id));
          let group = graphGroups(graph).find(g => !g.flags?.pinned && !g.pinned &&
            g.flags?.[PROPERTY]?.key === set.key && sameNodes(g.flags[PROPERTY].nodes, ids));
          if (!group) {
            group = new Group(options.groupTitle);
            graph.add(group);
          }
          group.title = options.grouping === "single" ? options.groupTitle : set.key === "Selection" ? options.groupTitle : set.key;
          group.flags = { ...group.flags, [PROPERTY]: { key: set.key, nodes: ids } };
          if (options.color !== "preserve") group.color = set.entries[0].colors.color;
          fitGroup(group, set.entries, options, plan.grid, Group);
        }
      }
      bridge?.sync();
      graph.change?.();
      return { count: eligible.length, skipped: nodes.length-eligible.length, plan };
    } catch (error) {
      // Roll back a custom node that throws while collapsing, including colors
      // and groups already processed before that failure.
      for (const snapshot of snapshots) restoreNode(snapshot);
      for (const group of [...graphGroups(graph)]) if (!originalGroups.includes(group)) graph.remove(group);
      for (const {g, data} of groupSnapshots) g.configure(data);
      bridge?.sync();
      throw error;
    }
  });
}

export function resetWidths({ canvas, graph, nodes, bridge }) {
  if (canvas.read_only) throw new Error("This workflow is read-only.");
  const selected = nodes.filter(n => n.graph === graph && n.properties?.[PROPERTY]);
  if (!selected.length) throw new Error("Select nodes previously packed with Pill Packer.");
  return transaction(canvas, graph, () => {
    for (const n of selected) { delete n.properties[PROPERTY]; n.setDirtyCanvas?.(true, true); }
    bridge?.sync(); graph.change?.();
    return selected.length;
  });
}
