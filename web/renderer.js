import { PROPERTY, titleOf } from "./packing.js";

const installed = new WeakSet();
export function packedWidth(node) {
  const value = node.properties?.[PROPERTY]?.width;
  return node.flags?.collapsed && Number.isFinite(value) && value >= 20 && value <= 10000 ? value : null;
}

function descriptorOf(object, key) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return null;
}

export function ellipsize(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  if (ctx.measureText("…").width > width) return "";
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(chars.slice(0, mid).join("") + "…").width <= width) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + "…";
}

// Hooks are installed only on participating node instances. Expanded size and
// node titles stay untouched; width lives in serializable workflow properties.
export function installNodeRenderer(node, litegraph) {
  if (installed.has(node)) return;
  const originalWidth = Object.getOwnPropertyDescriptor(node, "_collapsed_width");
  if (originalWidth && !originalWidth.configurable) throw new Error("This node locks its collapsed width and cannot be packed.");
  let naturalWidth = node._collapsed_width;
  Object.defineProperty(node, "_collapsed_width", {
    configurable: true, enumerable: false,
    get() { return packedWidth(this) ?? (originalWidth?.get ? originalWidth.get.call(this) : naturalWidth); },
    set(value) { naturalWidth = value; originalWidth?.set?.call(this, value); },
  });
  const sizeDescriptor = descriptorOf(node, "renderingSize");
  if (sizeDescriptor?.get && Object.getOwnPropertyDescriptor(node, "renderingSize")?.configurable !== false) {
    Object.defineProperty(node, "renderingSize", {
      configurable: true, enumerable: false,
      get() {
        const size = sizeDescriptor.get.call(this);
        const width = packedWidth(this);
        return width == null ? size : [width, size[1]];
      },
    });
  }
  const measure = node.measure;
  if (typeof measure === "function") node.measure = function(out, ...args) {
    const result = measure.call(this, out, ...args);
    const width = packedWidth(this);
    if (width != null) out[2] = width;
    return result;
  };
  const drawTitleText = node.drawTitleText;
  if (typeof drawTitleText === "function") node.drawTitleText = function(ctx, options = {}) {
    const width = packedWidth(this);
    if (width == null) return drawTitleText.call(this, ctx, options);
    const h = options.title_height || litegraph.NODE_TITLE_HEIGHT || 30;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(0, -h, width, h); ctx.clip();
      // Keep third-party title renderers; clip their output to the chosen pill.
      if (this.onDrawTitleText) return drawTitleText.call(this, ctx, options);
      if (options.low_quality) return;
      ctx.font = this.titleFontStyle || `${litegraph.NODE_TEXT_SIZE || 14}px Arial`;
      ctx.fillStyle = this.selected ? litegraph.NODE_SELECTED_TITLE_COLOR || "#fff"
        : this.constructor.title_text_color || "#fff";
      ctx.textAlign = "left";
      const text = titleOf(this) + (this.flags?.pinned ? " 📌" : "");
      ctx.fillText(ellipsize(ctx, text, Math.max(0, width - h * 2)), h, (litegraph.NODE_TITLE_TEXT_Y || 20) - h);
    } finally { ctx.restore(); }
  };
  installed.add(node);
}

const DOM_ATTRIBUTE = "data-pill-packer";
const DOM_SELECTOR = ".lg-node[data-node-id]";

// Vue's existing ResizeObserver reports these real DOM widths back to its
// layout store, keeping its chrome, ports, links and hit areas in agreement.
export function createDOMBridge(app) {
  let queued = false, observer = null;
  const elements = () => [...(app.canvasContainer || document).querySelectorAll(DOM_SELECTOR)];
  function sync() {
    queued = false;
    const graph = app.canvas?.graph;
    const nodes = new Map((graph?._nodes || []).map(n => [String(n.id), n]));
    for (const el of elements()) {
      const node = nodes.get(el.dataset.nodeId) || graph?.getNodeById?.(el.dataset.nodeId);
      const width = node ? packedWidth(node) : null;
      if (width == null) {
        if (el.hasAttribute(DOM_ATTRIBUTE)) {
          el.removeAttribute(DOM_ATTRIBUTE);
          el.style.removeProperty("--pill-packer-width");
        }
      } else {
        if (!el.hasAttribute(DOM_ATTRIBUTE)) el.setAttribute(DOM_ATTRIBUTE, "");
        const value = `${width}px`;
        if (el.style.getPropertyValue("--pill-packer-width") !== value) el.style.setProperty("--pill-packer-width", value);
      }
    }
  }
  function schedule() {
    if (!queued) { queued = true; requestAnimationFrame(sync); }
  }
  function start() {
    if (observer) return;
    observer = new MutationObserver(records => {
      if (records.some(r => r.type === "childList" || r.target.matches?.(DOM_SELECTOR))) schedule();
    });
    observer.observe(app.canvasContainer || document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-collapsed", "style", "class", "data-node-id"],
    });
    sync();
  }
  function metrics(nodes, litegraph) {
    const byId = new Map(elements().map(el => [el.dataset.nodeId, el]));
    const ctx = app.canvas?.ctx || document.createElement("canvas").getContext("2d");
    const titleHeight = litegraph.NODE_TITLE_HEIGHT || 30;
    let pillHeight = titleHeight;
    for (const node of nodes) {
      const el = byId.get(String(node.id));
      if (el) pillHeight = Math.max(pillHeight, node.flags?.collapsed ? el.offsetHeight : el.querySelector(".lg-node-header")?.offsetHeight || titleHeight);
    }
    return {
      grid: litegraph.CANVAS_GRID_SIZE || 20, titleHeight, pillHeight,
      measureTitle(node) {
        const el = byId.get(String(node.id));
        const title = el?.querySelector('[data-testid="node-title"]') || el?.querySelector(".lg-node-header");
        const font = title ? getComputedStyle(title).font : node.titleFontStyle || app.canvas?.title_text_font || `${litegraph.NODE_TEXT_SIZE || 14}px Arial`;
        ctx.save();
        try { ctx.font = font; return ctx.measureText(titleOf(node)).width + titleHeight * 2; }
        finally { ctx.restore(); }
      },
    };
  }
  return { start, sync, schedule, metrics, stop() { observer?.disconnect(); observer = null; } };
}
