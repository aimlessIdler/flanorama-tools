// Workflow run history with optional per-node drilldown and widget restore.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as core from "./timeline_core.js";
import { workflowHistory } from "./workflow-history.js";

const PREFIX = "/prompt_history/timeline";
const STYLE_ID = "pht-styles-v1";
const THUMB_LIMIT = 8;

let summary = { workflow_id: "", nodes: {} };
let refreshTimer = null;
let panel = null; // { root, body, status, node, token }

function rootGraph() { return app.rootGraph ?? app.graph; }

function currentWorkflowId() {
  const g = rootGraph();
  if (g?.id) return String(g.id);
  try {
    const id = app.graph?.serialize?.().id;
    if (id) return String(id);
  } catch { /* fall through */ }
  return "";
}

async function getJson(path, params) {
  const res = await api.fetchApi(`${PREFIX}${path}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshSummary() {
  const wid = currentWorkflowId();
  try {
    summary = await getJson("/workflow", { workflow_id: wid });
  } catch (error) {
    console.warn("Prompt History timeline: summary unavailable", error);
    summary = { workflow_id: wid, nodes: {} };
  }
  app.graph?.setDirtyCanvas(true, true);
}

function scheduleRefresh(delay = 300) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshSummary();
    if (panel) loadPanel();
  }, delay);
}

// ---- panel ---------------------------------------------------------------

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .pht-panel {position:fixed;top:56px;right:12px;width:min(620px,calc(100vw - 24px));max-height:calc(100vh - 72px);z-index:5000;display:flex;flex-direction:column;
      background:var(--comfy-menu-bg,#242424);color:var(--fg-color,#e6e6e6);border:1px solid var(--border-color,#555);border-radius:10px;
      box-shadow:0 10px 36px #0009;font:12px system-ui,sans-serif;overflow:hidden;}
    .pht-panel header {display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-color,#444);}
    .pht-panel header .pht-titles {flex:1;min-width:0;}
    .pht-panel h3 {margin:0;font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pht-panel .pht-sub {opacity:.65;margin-top:2px;}
    .pht-panel button {border:1px solid var(--border-color,#555);border-radius:5px;background:var(--comfy-input-bg,#292929);color:inherit;padding:3px 8px;cursor:pointer;font:inherit;}
    .pht-panel button:hover {background:var(--comfy-menu-bg,#444);}
    .pht-panel button:disabled {opacity:.35;cursor:default;}
    .pht-body {overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;min-height:80px;}
    .pht-entry {border:1px solid var(--border-color,#444);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;}
    .pht-entry.pht-latest {border-color:#c98a1a;}
    .pht-entry.pht-current {background:#ffffff0d;}
    .pht-head {display:flex;gap:8px;align-items:center;}
    .pht-head .pht-n {font-weight:650;}
    .pht-head .pht-time {opacity:.65;}
    .pht-head .pht-spacer {flex:1;}
    .pht-chip {border-radius:9px;padding:0 7px;font-size:11px;background:#46566b;color:#fff;}
    .pht-chip.pht-amber {background:#c98a1a;}
    .pht-change {display:grid;grid-template-columns:auto 1fr auto;gap:6px;align-items:baseline;}
    .pht-param {font-weight:600;white-space:nowrap;}
    .pht-vals {min-width:0;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace;font-size:11px;}
    .pht-old {opacity:.55;text-decoration:line-through;}
    .pht-arrow {opacity:.6;margin:0 4px;}
    .pht-initial {opacity:.65;}
    .pht-thumbs {display:flex;flex-wrap:wrap;gap:4px;}
    .pht-thumbs a,.pht-thumbs .pht-file {display:block;width:64px;height:64px;border-radius:4px;overflow:hidden;background:#0006;border:1px solid var(--border-color,#444);}
    .pht-thumbs img,.pht-thumbs video {width:100%;height:100%;object-fit:cover;display:block;}
    .pht-thumbs .pht-file {font-size:9px;padding:3px;overflow:hidden;overflow-wrap:anywhere;opacity:.8;}
    .pht-thumbs .pht-more {display:flex;align-items:center;padding:0 6px;opacity:.65;}
    .pht-panel details summary {cursor:pointer;opacity:.7;}
    .pht-panel details .pht-change {margin-top:4px;}
    .pht-actions {display:flex;gap:6px;}
    .pht-status {padding:6px 12px;border-top:1px solid var(--border-color,#444);opacity:.8;min-height:1.2em;}
    .pht-run-toolbar {display:flex;gap:6px;align-items:center;}
    .pht-run-toolbar select {min-width:0;flex:1;font:inherit;background:var(--comfy-input-bg,#292929);color:inherit;padding:6px;border:1px solid #555;border-radius:5px;}
    .pht-run-legend {display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px;}
    .pht-run-map {height:220px;position:relative;background:#1118;border-radius:6px;overflow:hidden;}
    .pht-run-map button {position:absolute;width:21%;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
    .pht-run-quick {white-space:pre-wrap;overflow-wrap:anywhere;min-height:32px;}
    .pht-run-delta {display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:8px;overflow-wrap:anywhere;}
    .pht-run-delta del {opacity:.55;}
    .pht-run-changes {display:grid;gap:8px;margin:10px 0;}
    .pht-empty {padding:14px 8px;opacity:.7;line-height:1.5;}
  `;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, title, onClick) {
  const b = el("button", "", label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); onClick(event); });
  return b;
}

function setStatus(text) { if (panel) panel.status.textContent = text; }

function onKeyDown(event) { if (event.key === "Escape") closePanel(); }

function closePanel() {
  if (!panel) return;
  panel.dispose?.();
  panel.root.remove();
  document.removeEventListener("keydown", onKeyDown);
  panel = null;
}

function openPanel(node = null) {
  closePanel();
  ensureStyle();
  const root = el("aside", "pht-panel");
  const header = el("header");
  const titles = el("div", "pht-titles");
  titles.append(el("h3", "", node ? node.title || node.type : "Workflow History"), el("div", "pht-sub", node ? `${node.type ?? ""} · node ${node.id}` : "Changes across queued runs"));
  header.append(titles);
  if (node) header.append(button("All runs", "Workflow History", () => openPanel()));
  header.append(button("✕", "Close", closePanel));
  const body = el("div", "pht-body");
  const status = el("div", "pht-status");
  root.append(header, body, status);
  document.body.appendChild(root);
  document.addEventListener("keydown", onKeyDown);
  panel = { root, body, status, node, token: 0 };
  loadPanel();
}

async function loadPanel() {
  if (!panel) return;
  const current = panel;
  const token = ++current.token;
  const wid = currentWorkflowId();
  if (!current.node) {
    if (!wid) {
      renderMessage("Queue this workflow to start its run history.");
      return;
    }
    if (current.dispose) current.dispose.refresh();
    else current.dispose = workflowHistory(current.body, wid, getJson, openPanel);
    return;
  }
  if (current.node.graph !== rootGraph()) {
    renderMessage("Timelines for nodes inside subgraphs are not available yet.");
    return;
  }
  if (!wid) {
    renderMessage("This workflow has no id yet. Queue it once, then reopen.");
    return;
  }
  try {
    const data = await getJson("/node", { workflow_id: wid, node_id: String(current.node.id), limit: "50" });
    if (panel !== current || token !== current.token) return;
    render(data);
  } catch (error) {
    if (panel === current) renderMessage(`Could not load history (${error.message}).`);
  }
}

function renderMessage(text) {
  if (!panel) return;
  panel.body.replaceChildren(el("div", "pht-empty", text));
}

function widgetFor(node, param) { return node.widgets?.find((w) => w.name === param); }

function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function applyRestore(node, restorable) {
  if (app.canvas?.read_only || !restorable.length) return 0;
  let applied = 0;
  node.graph?.beforeChange();
  try {
  for (const { param, value } of restorable) {
    const widget = widgetFor(node, param);
    if (!widget) continue;
    widget.value = value;
    try { widget.callback?.(value, app.canvas, node, null, null); } catch (error) { console.warn("Prompt History timeline restore", error); }
    applied++;
  }
  } finally { node.graph?.afterChange(node); }
  node.graph?.setDirtyCanvas(true, true);
  app.canvas?.setDirty?.(true, true);
  try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch { /* optional */ }
  return applied;
}

function valueSpan(value, className) {
  const f = core.formatValue(value);
  const span = el("span", className || "", f.text);
  span.title = f.full;
  return span;
}

function changeRow(node, param, oldValue, newValue, hasOld, hasNew, restoreTo, restoreParam = param) {
  const row = el("div", "pht-change");
  row.append(el("span", "pht-param", param));
  const vals = el("span", "pht-vals");
  if (hasOld) {
    vals.append(valueSpan(oldValue, "pht-old"));
    if (hasNew) vals.append(el("span", "pht-arrow", "→"));
  }
  if (hasNew) vals.append(valueSpan(newValue));
  else vals.append(el("span", "pht-initial", "  (removed)"));
  row.append(vals);
  const plan = hasNew ? core.planRestore({ [restoreParam]: restoreTo }, (node.widgets ?? []).map((w) => w.name)) : { restorable: [] };
  const undo = button("↩", plan.restorable.length ? (restoreParam === param ? "Restore this parameter to this state's value" : "Restore the full recorded " + restoreParam + " widget") : "No widget to restore (link or hidden input)", () => {
    setStatus(applyRestore(node, plan.restorable) ? `Restored ${param}.` : `${param} could not be restored.`);
    loadPanel();
  });
  undo.disabled = !plan.restorable.length;
  row.append(undo);
  return row;
}

function thumbs(outputs) {
  const wrap = el("div", "pht-thumbs");
  const shown = outputs.slice(-THUMB_LIMIT);
  for (const output of shown) {
    const url = api.apiURL(`/view?${core.viewQuery(output)}`);
    const kind = core.mediaKind(output);
    if (kind === "image") {
      const a = el("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.title = `${output.subfolder ? output.subfolder + "/" : ""}${output.filename}`;
      const img = el("img");
      img.loading = "lazy"; img.src = url; img.alt = "";
      img.addEventListener("error", () => {
        a.replaceChildren(el("span", "pht-file", "File unavailable"));
        a.removeAttribute("href");
      }, { once: true });
      a.append(img);
      wrap.append(a);
    } else if (kind === "video") {
      const a = el("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.title = output.filename;
      const video = el("video");
      video.muted = true; video.loop = true; video.preload = "metadata"; video.src = url;
      a.addEventListener("mouseenter", () => video.play().catch(() => {}));
      a.addEventListener("mouseleave", () => video.pause());
      a.append(video);
      wrap.append(a);
    } else {
      const f = el("div", "pht-file", output.filename);
      f.title = output.filename;
      wrap.append(f);
    }
  }
  if (outputs.length > shown.length) wrap.append(el("span", "pht-more", `+${outputs.length - shown.length}`));
  return wrap;
}

function render(data) {
  if (!panel) return;
  const node = panel.node;
  const widgetNames = (node.widgets ?? []).map((w) => w.name);
  const items = data.items ?? [];
  if (!items.length) {
    renderMessage("Nothing recorded for this node in this workflow yet. Queue a generation and it will appear here.");
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach((entry, index) => {
    const plan = core.planRestore(entry.inputs, widgetNames);
    const isCurrent = plan.restorable.length > 0 && plan.restorable.every(({ param, value }) => sameValue(widgetFor(node, param)?.value, value));
    const card = el("div", "pht-entry" + (index === 0 ? " pht-latest" : "") + (isCurrent ? " pht-current" : ""));

    const head = el("div", "pht-head");
    head.append(el("span", "pht-n", `#${data.total - index}`));
    const time = el("span", "pht-time", core.relativeTime(entry.last_ts_ms));
    time.title = new Date(entry.last_ts_ms).toLocaleString();
    head.append(time);
    if (entry.event_count > 1) head.append(el("span", "pht-chip", `${entry.event_count} runs`));
    if (index === 0) head.append(el("span", "pht-chip pht-amber", "latest"));
    if (isCurrent) head.append(el("span", "pht-chip", "on canvas"));
    head.append(el("span", "pht-spacer"));
    const restoreAll = button("Restore", plan.restorable.length ? `Write ${plan.restorable.length} parameter(s) back to the node` : "Nothing restorable", () => {
      const n = applyRestore(node, plan.restorable);
      const skipped = plan.skipped.length ? ` ${plan.skipped.length} skipped (links or hidden inputs).` : "";
      setStatus(`Restored ${n} parameter(s) from #${data.total - index}.${skipped}`);
      loadPanel();
    });
    restoreAll.disabled = !plan.restorable.length;
    head.append(restoreAll);
    card.append(head);

    if (entry.changes.length) {
      for (const c of core.readableChanges(entry.changes)) {
        card.append(changeRow(node, c.param, c.old, c.new, c.old !== undefined, c.new !== undefined, entry.inputs[c.source], c.source));
      }
    } else {
      card.append(el("div", "pht-initial", index === items.length - 1 && items.length === data.total ? "First recorded state" : "Same as the state before it in the list"));
    }

    if (entry.outputs.length) card.append(thumbs(entry.outputs));

    const keys = Object.keys(entry.inputs ?? {});
    if (keys.length) {
      const details = el("details");
      details.append(el("summary", "", `All parameters (${keys.length})`));
      for (const key of keys) details.append(changeRow(node, key, undefined, entry.inputs[key], false, true, entry.inputs[key]));
      card.append(details);
    }
    frag.append(card);
  });
  const more = data.total > items.length ? el("div", "pht-empty", `Showing the newest ${items.length} of ${data.total} entries.`) : null;
  panel.body.replaceChildren(frag);
  if (more) panel.body.append(more);
  if (!panel.status.textContent) setStatus(`${data.total} recorded ${data.total === 1 ? "entry" : "entries"} · workflow ${currentWorkflowId().slice(0, 8)}`);
}

// ---- wiring ----------------------------------------------------------------

function listen(name, handler) {
  if (typeof api.addCustomEventListener === "function") api.addCustomEventListener(name, handler);
  else api.addEventListener(name, handler);
}

app.registerExtension({
  name: "prompt_history.timeline",
  commands: [{ id: "Flanorama.WorkflowHistory", label: "Workflow History", function: () => openPanel() }],
  menuCommands: [{ path: ["Edit", "Flanorama"], commands: ["Flanorama.WorkflowHistory"] }],
  getCanvasMenuItems: () => [{ content: "Workflow History…", callback: () => openPanel() }],
  async beforeRegisterNodeDef(nodeType) {
    const original = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const result = original?.apply(this, arguments);
      if (Array.isArray(options)) options.push(null, { content: "Workflow History…", callback: () => openPanel() }, { content: "Node timeline…", callback: () => openPanel(this) });
      return result;
    };
  },

  async setup() {
    listen("prompt_history.timeline", () => scheduleRefresh(150));
    api.addEventListener("execution_success", () => scheduleRefresh(500));
    api.addEventListener("executed", () => { if (panel) scheduleRefresh(800); });
    refreshSummary();
    window.__phTimeline = { refreshSummary, openPanel, get summary() { return summary; }, currentWorkflowId };
  },
  async afterConfigureGraph() {
    closePanel();
    scheduleRefresh(200);
  },
});
