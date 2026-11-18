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

// Compare serialized values literally, expanding only fields that changed.
export function readableChanges(changes) {
  const decode = value => {
    if (typeof value !== "string") return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : value;
    } catch { return value; }
  };
  const output = [];
  function visit(path, before, after, source, hasOld, hasNew) {
    const old = decode(before), next = decode(after);
    if (hasOld === hasNew && JSON.stringify(old) === JSON.stringify(next)) return;
    const oldObject = old !== null && typeof old === "object" && !isLink(old);
    const newObject = next !== null && typeof next === "object" && !isLink(next);
    const compatible = oldObject && newObject && Array.isArray(old) === Array.isArray(next);
    if (compatible || (!hasOld && newObject) || (!hasNew && oldObject)) {
      const keys = new Set([...Object.keys(oldObject ? old : {}), ...Object.keys(newObject ? next : {})]);
      if (keys.size) {
        for (const key of keys) {
          const array = Array.isArray(oldObject ? old : next);
          const child = array ? path + "[" + key + "]" : path + "." + key;
          const beforeExists = oldObject && Object.hasOwn(old, key);
          const afterExists = newObject && Object.hasOwn(next, key);
          visit(child, beforeExists ? old[key] : undefined, afterExists ? next[key] : undefined,
            source, beforeExists, afterExists);
        }
        return;
      }
    }
    output.push({ param: path, old: before, new: after, source, hasOld, hasNew });
  }
  for (const change of changes) {
    visit(change.param, change.old, change.new, change.param, "old" in change, "new" in change);
  }
  return output;
}
