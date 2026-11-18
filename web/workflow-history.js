import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { readableChanges, formatValue, relativeTime } from "./timeline_core.js";

const colors = { changed: "#e7ad42", added: "#47c2a9", removed: "#e78484", unchanged: "#697584" };
function el(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function button(text, action) {
  const item = el("button", text);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}
function deltaRow(change) {
  const row = el("div", undefined, "pht-run-delta");
  row.append(el("strong", change.param));
  const values = el("span");
  if (change.old !== undefined) {
    const old = el("del", formatValue(change.old, 180).text);
    old.title = formatValue(change.old).full;
    values.append(old, document.createTextNode(" → "));
  }
  const next = el("span", change.hasNew === false ? "(removed)" : formatValue(change.new, 180).text);
  next.title = formatValue(change.new).full;
  values.append(next);
  if (change.hasOld === false) values.append(document.createTextNode(" (added)"));
  row.append(values);
  return row;
}

export function workflowHistory(body, workflowId, getJson, openNode) {
  const selector = el("select");
  selector.setAttribute("aria-label", "Queued run");
  const more = button("Older runs", () => loadEvents(true));
  const refresh = button("Refresh", () => loadEvents(false));
  const toolbar = el("div", undefined, "pht-run-toolbar");
  toolbar.append(selector, refresh, more);
  const content = el("div");
  body.replaceChildren(toolbar, content);
  let events = [], selected, request = 0, disposed = false;
  const showError = error => { if (!disposed) content.replaceChildren(el("p", error.message)); };

  async function loadEvents(append) {
    const query = { workflow_id: workflowId, limit: "50" };
    if (append && events.length) query.before_id = events.at(-1).id;
    const generation = ++request;
    try {
      const result = await getJson("/events", query);
      if (disposed || generation !== request) return;
      events = append ? [...events, ...result.items] : result.items;
      selector.replaceChildren(...events.map(event => {
        const option = el("option", "#" + event.id + " · " + new Date(event.ts_ms).toLocaleString());
        option.value = event.id;
        return option;
      }));
      more.disabled = result.items.length < 50;
      if (!events.length) {
        content.replaceChildren(el("p", "Queue this workflow to start its run history."));
        return;
      }
      if (!events.some(event => event.id === selected)) selected = events[0].id;
      selector.value = String(selected);
      await loadRun();
    } catch (error) { if (generation === request) showError(error); }
  }
  selector.addEventListener("change", () => {
    selected = Number(selector.value);
    loadRun().catch(showError);
  });

  async function loadRun() {
    const generation = ++request;
    const data = await getJson("/run", { id: String(selected) });
    if (disposed || generation !== request) return;
    const comparison = data.comparison;
    const heading = el("p", comparison.a === null
      ? "First recorded run · baseline"
      : "Changes since run #" + comparison.a + " · " + relativeTime(data.ts_ms));
    const counts = el("div", undefined, "pht-run-legend");
    for (const [status, count] of Object.entries(comparison.summary)) {
      const label = el("span", count + " " + status);
      label.style.color = colors[status];
      counts.append(label);
    }
    const map = el("div", undefined, "pht-run-map");
    map.setAttribute("aria-label", "Workflow change map");
    const quick = el("p", "Hover or focus a node to see its changes.", "pht-run-quick");
    const detail = el("div");
    const nodes = comparison.nodes;
    const positions = nodes.map((node, index) => {
      const pos = data.layout[node.node_id]?.pos;
      return Array.isArray(pos) ? pos : [(index % 5) * 240, Math.floor(index / 5) * 140];
    });
    const xs = positions.map(pos => pos[0]), ys = positions.map(pos => pos[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const spanX = Math.max(...xs) - minX || 1, spanY = Math.max(...ys) - minY || 1;
    if (!Object.keys(data.layout).length) map.title = "This older run has no saved canvas positions. Nodes are shown in a grid.";
    nodes.forEach((node, index) => {
      const label = node.title || node.class_type;
      const changes = readableChanges(node.changes);
      const summary = changes.map(change => change.param + ": " + formatValue(change.old, 55).text + " → " + formatValue(change.new, 55).text).join("; ");
      const tile = button(label, () => showNode(node));
      tile.style.left = (2 + (positions[index][0] - minX) / spanX * 76) + "%";
      tile.style.top = (6 + (positions[index][1] - minY) / spanY * 76) + "%";
      tile.style.borderColor = colors[node.status];
      tile.style.color = colors[node.status];
      tile.title = label + " · " + node.status + (summary ? "\n" + summary : "");
      tile.setAttribute("aria-label", tile.title);
      tile.addEventListener("mouseenter", () => { quick.textContent = tile.title; });
      tile.addEventListener("focus", () => { quick.textContent = tile.title; });
      map.append(tile);
    });
    function showNode(node) {
      detail.replaceChildren();
      const card = el("section", undefined, "pht-entry");
      card.style.borderColor = colors[node.status];
      const header = el("div", undefined, "pht-head");
      header.append(el("strong", (node.title || node.class_type) + " · " + node.status));
      const live = (app.rootGraph ?? app.graph)?.getNodeById(node.node_id);
      if (live && (live.comfyClass === node.class_type || live.type === node.class_type)) {
        header.append(button("Node history", () => openNode(live)));
      }
      card.append(header);
      const changes = readableChanges(node.changes);
      for (const change of changes) card.append(deltaRow(change));
      if (!changes.length) card.append(el("p", node.status === "unchanged" ? "No parameter changes in this run." : node.status === "changed" ? "No displayed parameter values changed." : node.status === "added" ? "Added to this run." : "Removed from this run."));
      detail.append(card);
    }
    const changed = nodes.filter(node => node.status !== "unchanged");
    const list = el("div", undefined, "pht-run-changes");
    for (const node of changed) {
      const card = el("section", undefined, "pht-entry");
      card.append(button((node.title || node.class_type) + " · " + node.status, () => showNode(node)));
      for (const change of readableChanges(node.changes)) card.append(deltaRow(change));
      list.append(card);
    }
    if (!changed.length) list.append(el("p", "No input changes since the preceding queued run."));
    const outputs = el("details");
    outputs.append(el("summary", "Outputs from this run (" + data.outputs.length + ")"));
    for (const output of data.outputs) {
      const link = el("a", output.filename);
      link.href = api.apiURL("/view?" + new URLSearchParams({
        filename: output.filename, subfolder: output.subfolder || "", type: output.type || "output",
      }));
      link.target = "_blank"; link.rel = "noopener noreferrer";
      outputs.append(link, el("br"));
    }
    content.replaceChildren(heading, counts, map, quick, detail, list, outputs);
  }

  loadEvents(false);
  const dispose = () => { disposed = true; request++; };
  dispose.refresh = () => loadEvents(false);
  return dispose;
}
