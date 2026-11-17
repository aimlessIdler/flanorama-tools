// Pure layout calculations. No ComfyUI or browser dependencies.
export const PROPERTY = "pill_packer";
export const DEFAULTS = Object.freeze({
  layout: "type", columns: 3, order: "visual", width: "stack",
  gapY: 1, gapX: 2, minWidth: 6, maxWidth: 24, fixedWidth: 12, minWidthFromTitle: false,
  color: "preserve", grouping: "none", padding: 2,
  groupTitle: "Ne'er Be Seen Again", skipPinned: true,
});

const choices = {
  layout: ["type", "category", "stack", "columns"],
  order: ["visual", "title", "type", "connections"],
  width: ["fit", "stack", "selection", "fixed"],
  color: ["preserve", "type", "category", "stack"],
  grouping: ["none", "single", "stacks", "existing"],
};

export function normalizeOptions(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const result = { ...DEFAULTS };
  for (const [key, values] of Object.entries(choices)) {
    if (values.includes(input[key])) result[key] = input[key];
  }
  const limits = { columns: [1, 20], gapY: [0, 20], gapX: [0, 40],
    minWidth: [3, 100], maxWidth: [0, 100], fixedWidth: [3, 100], padding: [0, 20] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (input[key] === "" || input[key] == null) continue;
    const n = Number(input[key]);
    if (Number.isFinite(n)) result[key] = Math.max(min, Math.min(max, Math.round(n)));
  }
  if (result.maxWidth && result.maxWidth < result.minWidth) result.maxWidth = result.minWidth;
  if (typeof input.groupTitle === "string") result.groupTitle = input.groupTitle.trim().slice(0, 120) || DEFAULTS.groupTitle;
  for (const key of ["skipPinned", "minWidthFromTitle"]) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  return result;
}

export function titleOf(node) {
  return String(node.getTitle?.() ?? node.title ?? node.type ?? "Node");
}
export function categoryOf(node) {
  return String(node.constructor?.category || node.constructor?.nodeData?.category || "Other").split("/")[0];
}
export function keyFor(node, by) {
  if (by === "category") return categoryOf(node);
  if (by === "type") return String(node.type || titleOf(node));
  return "Selection";
}
const visualCompare = (a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0] || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
const idCompare = (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

export function orderedNodes(nodes, order, edges = []) {
  const sorted = [...nodes].sort(visualCompare);
  if (order === "title" || order === "type") {
    return sorted.sort((a, b) => (order === "type" ? keyFor(a, "type") : titleOf(a)).localeCompare(order === "type" ? keyFor(b, "type") : titleOf(b), undefined, { numeric: true }) || idCompare(a, b));
  }
  if (order !== "connections") return sorted;
  sorted.sort(idCompare);
  const byId = new Map(sorted.map(n => [String(n.id), n]));
  const incoming = new Map(sorted.map(n => [String(n.id), 0]));
  const outgoing = new Map(sorted.map(n => [String(n.id), new Set()]));
  for (const [from, to] of edges) {
    const a = String(from), b = String(to);
    if (a === b || !byId.has(a) || !byId.has(b) || outgoing.get(a).has(b)) continue;
    outgoing.get(a).add(b); incoming.set(b, incoming.get(b) + 1);
  }
  const queue = sorted.filter(n => !incoming.get(String(n.id)));
  const result = [], seen = new Set();
  while (queue.length) {
    const n = queue.shift(), id = String(n.id);
    result.push(n); seen.add(id);
    for (const target of outgoing.get(id)) {
      incoming.set(target, incoming.get(target) - 1);
      if (!incoming.get(target)) queue.push(byId.get(target));
    }
    queue.sort(idCompare);
  }
  return result.concat(sorted.filter(n => !seen.has(String(n.id))));
}

export function colorFor(key) {
  // Stable across selections and reloads, with white-text-friendly backgrounds.
  let hash = 2166136261;
  for (const char of String(key)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  // Avalanche the result so types differing only by a digit don't get nearly
  // identical hues from the low bits of FNV.
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  hash ^= hash >>> 16;
  const h = ((hash >>> 0) % 360) / 60;
  const c = 0.40, x = c * (1 - Math.abs(h % 2 - 1)), m = 0.15;
  const rgb = h < 1 ? [c,x,0] : h < 2 ? [x,c,0] : h < 3 ? [0,c,x] : h < 4 ? [0,x,c] : h < 5 ? [x,0,c] : [c,0,x];
  const hex = rgb.map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
  return { color: `#${hex}`, bgcolor: `#${hex}` };
}

export function planPacking(nodes, input, metrics = {}) {
  const options = normalizeOptions(input);
  const grid = Number.isFinite(metrics.grid) && metrics.grid > 0 ? metrics.grid : 20;
  const titleHeight = metrics.titleHeight || 30;
  const height = Math.max(titleHeight, metrics.pillHeight || titleHeight);
  const snap = value => Math.ceil(value / grid) * grid;
  const sorted = orderedNodes(nodes, options.order, metrics.edges);
  if (options.layout === "columns" && options.order === "visual") sorted.sort((a,b) => a.pos[0]-b.pos[0] || visualCompare(a,b));
  if (!sorted.length) return { options, entries: [], stacks: [], bounds: null, grid };
  const stacks = [];
  if (options.layout === "type" || options.layout === "category") {
    const buckets = new Map();
    // Order stacks spatially left-to-right, then by their top edge.
    for (const node of [...nodes].sort((a,b) => a.pos[0]-b.pos[0] || visualCompare(a,b))) {
      const key = keyFor(node, options.layout);
      if (!buckets.has(key)) buckets.set(key, []);
    }
    for (const node of sorted) buckets.get(keyFor(node, options.layout)).push(node);
    for (const [key, values] of buckets) stacks.push({ key, nodes: values });
  } else if (options.layout === "columns") {
    const count = Math.min(options.columns, sorted.length);
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const length = Math.floor(sorted.length / count) + (i < sorted.length % count ? 1 : 0);
      stacks.push({ key: `Stack ${i + 1}`, nodes: sorted.slice(offset, offset + length) });
      offset += length;
    }
  } else stacks.push({ key: "Selection", nodes: sorted });
  const measure = metrics.measureTitle || (n => titleOf(n).length * 8 + titleHeight * 2);
  const controlMinimum = snap(titleHeight * 2);
  const clampWidth = width => Math.max(controlMinimum, options.minWidth * grid, Math.min(options.maxWidth ? options.maxWidth * grid : Infinity, snap(width)));
  const measured = new Map(sorted.map(n => [n, snap(measure(n))]));
  const natural = new Map(sorted.map(n => [n, clampWidth(measured.get(n))]));
  const minimums = new Map(stacks.map(stack => [stack, Math.max(controlMinimum, options.minWidth * grid,
    options.minWidthFromTitle ? Math.max(...stack.nodes.map(n => measured.get(n))) : 0)]));
  const common = Math.max(...natural.values(), ...minimums.values());
  // Preserve the top-left of the selection, including when it was already packed.
  const anchor = metrics.anchor || [Math.min(...nodes.map(n => n.pos[0])), Math.min(...nodes.map(n => n.pos[1])) - titleHeight];
  let x = Math.round(anchor[0] / grid) * grid;
  const top = Math.round(anchor[1] / grid) * grid;
  const rowStep = snap(height + options.gapY * grid);
  const entries = [];
  for (const [stackIndex, stack] of stacks.entries()) {
    const stackWidth = Math.max(...stack.nodes.map(n => natural.get(n)));
    stack.entries = stack.nodes.map((node, row) => {
      const preferred = options.width === "fixed" ? Math.max(controlMinimum, Math.max(options.minWidth, options.fixedWidth) * grid)
        : options.width === "selection" ? common : options.width === "stack" ? stackWidth : natural.get(node);
      const width = Math.max(preferred, minimums.get(stack));
      const colorKey = options.color === "stack" ? stack.key : keyFor(node, options.color);
      const entry = { node, x, y: top + row * rowStep, width, height, stackIndex,
        colors: options.color === "preserve" ? null : colorFor(colorKey) };
      entries.push(entry); return entry;
    });
    stack.bounds = boundsOf(stack.entries);
    const gap = options.grouping === "stacks" ? Math.max(options.gapX, options.padding * 2 + 1) : options.gapX;
    x += snap(Math.max(stack.bounds.width, options.grouping === "stacks" ? 140 - options.padding * grid * 2 : 0) + gap * grid);
  }
  return { options, entries, stacks, bounds: boundsOf(entries), grid, titleHeight };
}

export function boundsOf(entries) {
  const x = Math.min(...entries.map(e => e.x)), y = Math.min(...entries.map(e => e.y));
  return { x, y, width: Math.max(...entries.map(e => e.x + e.width)) - x,
    height: Math.max(...entries.map(e => e.y + e.height)) - y };
}
