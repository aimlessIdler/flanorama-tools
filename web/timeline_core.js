// Pure helpers for the node timeline UI. No ComfyUI imports, so they can be tested with plain node.

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;

// API-format link inputs look like ["12", 0]: a node id string and an output slot number.
export function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

export function formatValue(value, max = 120) {
  let full;
  if (isLink(value)) full = `← node ${value[0]} (slot ${value[1]})`;
  else if (typeof value === "string") full = value;
  else if (value === undefined) full = "(absent)";
  else full = JSON.stringify(value);
  const text = full.length > max ? full.slice(0, max - 1) + "…" : full;
  return { text, full, link: isLink(value) };
}

export function relativeTime(thenMs, nowMs = Date.now()) {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(thenMs).toLocaleDateString();
}

export function viewQuery(output) {
  return new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder || "",
    type: output.type || "output",
  }).toString();
}

export function mediaKind(output) {
  if (VIDEO_EXT.test(output.filename || "")) return "video";
  if (output.kind === "images") return "image";
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(output.filename || "")) return "image";
  return "file";
}

// Which parameters of a recorded state can be written back to a node's widgets.
// Links (wiring) and parameters with no matching widget are reported as not restorable.
export function planRestore(inputs, widgetNames) {
  const names = new Set(widgetNames);
  const restorable = [];
  const skipped = [];
  for (const [param, value] of Object.entries(inputs || {})) {
    if (isLink(value)) skipped.push({ param, reason: "link" });
    else if (!names.has(param)) skipped.push({ param, reason: "no widget" });
    else restorable.push({ param, value });
  }
  return { restorable, skipped };
}

export function badgeInfo(summaryNode) {
  if (!summaryNode || summaryNode.states < 2) return null;
  return { label: String(summaryNode.states), changed: !!summaryNode.changed_in_latest };
}

export function badgeRect(nodeWidth, titleHeight, label) {
  const w = Math.max(26, 14 + label.length * 7);
  const h = Math.min(18, titleHeight - 8);
  return { x: nodeWidth - w - 28, y: -titleHeight + (titleHeight - h) / 2, w, h };
}

export function inRect(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// Interpret structured inputs using their shape. Custom nodes need no adapters.
export function readableChanges(changes) {
  const decoded = value => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const labelFor = key => {
    const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const output = [];
  function visit(label, oldValue, newValue, source) {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    if (output.length >= 100) return;
    const old = decoded(oldValue), next = decoded(newValue);
    if (old && next && typeof old === "object" && typeof next === "object" &&
        !isLink(old) && !isLink(next) && Array.isArray(old) === Array.isArray(next)) {
      const prefix = label ? label + " · " : "";
      const skipped = new Set();
      // Width/height pairs are common across image, video, and latent nodes.
      const dimensions = ["width", "height"].every(key => key in old && key in next)
        ? ["width", "height"] : ["w", "h"].every(key => key in old && key in next) ? ["w", "h"] : null;
      if (dimensions && dimensions.every(key => Number.isFinite(old[key]) && Number.isFinite(next[key]))) {
        const [width, height] = dimensions;
        visit(prefix + "Dimensions", old[width] + " × " + old[height], next[width] + " × " + next[height], source);
        dimensions.forEach(key => skipped.add(key));
      }
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (skipped.has(key)) continue;
        let before = old[key], after = next[key];
        // Resolve an index into an unambiguous sibling collection, so the
        // selected value is visible even when the node serializes an index.
        if (/^(selected|selected_index|active_index|index)$/i.test(key) &&
            Number.isInteger(before) && Number.isInteger(after)) {
          const collections = Object.keys(next).filter(name =>
            Array.isArray(old[name]) && Array.isArray(next[name]) &&
            before >= 0 && after >= 0 && before < old[name].length && after < next[name].length);
          if (collections.length === 1) {
            const name = collections[0];
            before = old[name][before];
            after = next[name][after];
            if (JSON.stringify(before) !== JSON.stringify(after)) {
              output.push({ param: prefix + labelFor(key), old: before, new: after, source });
              continue;
            }
          }
        }
        visit(prefix + labelFor(key), before, after, source);
      }
    } else {
      output.push({ param: label, old: oldValue, new: newValue, source });
    }
  }
  for (const change of changes) visit(labelFor(change.param), change.old, change.new, change.param);
  if (output.length === 100) output.push({param:"More changes", new:"Open all parameters for the full state"});
  return output;
}
