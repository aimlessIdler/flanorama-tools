import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PREFIX = "/prompt_history";
const styleId = "prompt-history-styles-v1";
const historyRefreshers = new Set();


function ensureStyle() {
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    .ph-toolbar {display:flex;align-items:center;gap:5px;width:100%;height:36px;padding:2px 3px;box-sizing:border-box;font:12px system-ui,sans-serif;color:var(--fg-color,#ddd);}
    .ph-toolbar button,.ph-dialog button {border:1px solid var(--border-color,#555);border-radius:5px;background:var(--comfy-input-bg,#292929);color:var(--fg-color,#eee);padding:5px 9px;cursor:pointer;font:inherit;}
    .ph-toolbar button:hover,.ph-dialog button:hover {background:var(--comfy-menu-bg,#444);}
    .ph-toolbar button:disabled,.ph-dialog button:disabled {opacity:.35;cursor:default;}
    .ph-toolbar .ph-count {min-width:58px;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums;}
    .ph-dialog-backdrop {position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100000;display:flex;align-items:center;justify-content:center;padding:22px;box-sizing:border-box;}
    .ph-dialog {background:var(--comfy-menu-bg,#242424);color:var(--fg-color,#e9e9e9);border:1px solid var(--border-color,#555);border-radius:12px;box-shadow:0 15px 50px #0009;width:min(830px,94vw);max-height:85vh;overflow:hidden;display:flex;flex-direction:column;gap:12px;padding:17px;box-sizing:border-box;font:13px system-ui,sans-serif;}
    .ph-dialog header,.ph-dialog .ph-actions {display:flex;gap:9px;align-items:center;justify-content:space-between;flex-wrap:wrap;}
    .ph-dialog h3{font-size:17px;margin:0;font-weight:650;}
    .ph-dialog input[type=search],.ph-dialog input[type=number] {color:inherit;background:var(--comfy-input-bg,#191919);border:1px solid var(--border-color,#555);border-radius:5px;padding:7px;min-width:0;}
    .ph-dialog input[type=search] {width:100%;flex:1;}
    .ph-dialog .ph-items {min-height:160px;overflow:auto;border:1px solid var(--border-color,#555);border-radius:7px;flex:1;}
    .ph-dialog .ph-entry {display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border-color,#454545);padding:8px 10px;}
    .ph-dialog .ph-entry:last-child{border-bottom:none;}
    .ph-dialog .ph-preview{flex:1;min-width:0;white-space:pre-line;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;}
    .ph-dialog .ph-mini {font-size:11px;color:var(--descrip-text,#aaa);white-space:nowrap;}
    .ph-dialog .ph-danger{border-color:#924a4a;}
    .ph-dialog .ph-status{font-size:12px;opacity:.78;min-height:1em;}
  `;
  document.head.appendChild(style);
}

async function request(path, body = undefined) {
  const res = await api.fetchApi(PREFIX + path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function makeButton(label, title, fn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", (e) => {e.preventDefault();e.stopPropagation();Promise.resolve(fn(e)).catch(error => window.alert("Prompt History: " + error.message));});
  return btn;
}

function findPromptWidget(node) { return node.widgets?.find(w => w.name === "prompt"); }
function getPrompt(node) { return String(findPromptWidget(node)?.value ?? ""); }
function setPrompt(node, text) {
  const w = findPromptWidget(node);
  if (!w) throw new Error("Prompt widget is missing or converted to an input. Restore its widget to browse history.");
  w.value = text;
  w.callback?.(text);
  node.graph?.setDirtyCanvas(true, true);
}

function buildToolbar(node) {
  if (node._phInitialized) return;
  node._phInitialized = true;
  ensureStyle();
  const container = document.createElement("div");
  container.className = "ph-toolbar";
  let index = -1;  // -1 is editor/draft, 0 is newest saved prompt.
  let draft = "";
  let total = 0;
  let loading = false;
  const older = makeButton("◀", "Older saved prompt", async () => move(1));
  const count = document.createElement("span");
  count.className = "ph-count";
  count.textContent = "History";
  const newer = makeButton("▶", "Newer saved prompt (returns to draft)", async () => move(-1));
  const save = makeButton("Save", "Store this prompt without queueing", async () => {
    const text = getPrompt(node);
    if (!text.trim()) return;
    await request("/save", { text });
    index = -1;
    draft = text;
    await refreshCount();
  });
  const library = makeButton("Manage…", "Search, pin, delete, import, export and limit history", async () => openLibrary(node, () => refreshCount()));
  container.append(older, count, newer, save, library);

  async function refreshCount() {
    const data = await request("/list?limit=1");
    total = data.total;
    display();
  }
  function display() {
    count.textContent = index < 0 ? `${total} saved` : `${index + 1} / ${total}`;
    older.disabled = loading || (total === 0 || index >= total - 1);
    newer.disabled = loading || index === -1;
    save.disabled = loading;
  }
  async function move(delta) {
    if (loading) return;
    loading = true;
    display();
    try {
      if (index < 0 && delta === 1) draft = getPrompt(node);
      const target = index + delta;
      if (target < -1 || target >= total) return;
      if (target === -1) {
        setPrompt(node, draft);
        index = -1;
      } else {
        const data = await request(`/list?limit=1&offset=${target}`);
        total = data.total;
        if (!data.items.length) return;
        setPrompt(node, data.items[0].text);
        index = target;
      }
    } finally {
      loading = false;
      display();
    }
  }
  const widget = node.addDOMWidget("history_toolbar", "ph_toolbar", container, {
    serialize: false, hideOnZoom: false, getMinHeight: () => 38,
  });
  widget.serializeValue = () => undefined;
  widget.computeSize = (width) => [width, 38];
  node.setSize([Math.max(node.size?.[0] ?? 0, 370), Math.max(node.size?.[1] ?? 0, node.computeSize?.([370,320])?.[1] ?? 320)]);
  historyRefreshers.add(refreshCount);
  const oldRemoved = node.onRemoved;
  node.onRemoved = function(...args) {
    historyRefreshers.delete(refreshCount);
    return oldRemoved?.apply(this, args);
  };
  refreshCount().catch(error => { count.textContent = "History offline"; console.warn("Prompt History", error); });
}

async function openLibrary(node, afterChange) {
  ensureStyle();
  const backdrop = document.createElement("div");
  backdrop.className = "ph-dialog-backdrop";
  const box = document.createElement("section");
  box.className = "ph-dialog";
  backdrop.appendChild(box);
  backdrop.addEventListener("mousedown", e => { if (e.target === backdrop) close(); });
  backdrop.addEventListener("keydown", e => {if(e.key === "Escape")close();});

  const header = document.createElement("header");
  const title = document.createElement("h3"); title.textContent = "Prompt History";
  const closeBtn = makeButton("✕", "Close", () => close());
  header.append(title, closeBtn);
  const controls = document.createElement("div"); controls.className = "ph-actions";
  const search = document.createElement("input"); search.type="search"; search.placeholder="Search saved prompts…";
  const pinnedLabel=document.createElement("label");
  const pinnedCheck=document.createElement("input"); pinnedCheck.type="checkbox";
  pinnedLabel.append(pinnedCheck,document.createTextNode(" Pinned only"));
  controls.append(search,pinnedLabel);
  const items = document.createElement("div"); items.className="ph-items";
  const paging = document.createElement("div"); paging.className="ph-actions";
  const back = makeButton("◀ Previous", "Previous page", async()=>{offset=Math.max(0,offset-100);await load();});
  const page = document.createElement("span"); page.className="ph-mini";
  const forward = makeButton("Next ▶", "Next page", async()=>{offset+=100;await load();});
  paging.append(back,page,forward);
  const housekeeping = document.createElement("div"); housekeeping.className="ph-actions";
  const sizeLabel=document.createElement("label"); sizeLabel.textContent="Maximum entries (0 = unlimited): ";
  const maxInput=document.createElement("input"); maxInput.type="number";maxInput.min="0";maxInput.max="10000000";maxInput.step="1";maxInput.style.width="85px";
  sizeLabel.append(maxInput);
  const setLimit=makeButton("Apply", "Set the optional total entry limit", async()=>{await request("/settings",{max_entries:Number(maxInput.value)});await load();afterChange?.();});
  const exp=makeButton("Export", "Back up entire history as JSON", async()=>{
    const data=await request("/export");
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");link.href=url;link.download="prompt-history.json";document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  const imp=makeButton("Import", "Restore or merge a JSON history export",async()=>fileInput.click());
  const fileInput=document.createElement("input");fileInput.type="file";fileInput.accept="application/json,.json";fileInput.hidden=true;
  fileInput.addEventListener("change",async()=>{
    try{
      const file=fileInput.files?.[0];if(!file)return;
      const parsed=JSON.parse(await file.text());
      const arr=Array.isArray(parsed)?parsed:parsed.items;
      const out=await request("/import",{items:arr});
      alert(`Imported ${out.imported} prompts.`);
      offset=0;await load();afterChange?.();
    }catch(error){alert("Prompt History: "+error.message);}finally{fileInput.value="";}
  });
  const clear=makeButton("Clear unpinned", "Remove all unpinned saved prompts",async()=>{
    if (!window.confirm("Delete ALL unpinned prompts from the history? This cannot be undone.")) return;
    await request("/clear",{include_pinned:false});offset=0;await load();afterChange?.();
  });clear.className="ph-danger";
  const clearAll=makeButton("Clear ALL", "Delete even pinned prompts",async()=>{
    if(!window.confirm("Delete the ENTIRE prompt history, including pinned prompts?"))return;
    if(!window.confirm("This permanently deletes all saved prompt text. Are you certain?"))return;
    await request("/clear",{include_pinned:true});offset=0;await load();afterChange?.();
  });clearAll.className="ph-danger";
  housekeeping.append(sizeLabel,setLimit,exp,imp,fileInput,clear,clearAll);
  const status=document.createElement("div");status.className="ph-status";
  status.textContent="The history is shared across workflows and stored on the ComfyUI server.";
  box.append(header,controls,items,paging,housekeeping,status);
  document.body.appendChild(backdrop);
  search.focus();
  let offset=0;
  let delay=null;
  function close(){clearTimeout(delay);backdrop.remove();afterChange?.();}
  search.addEventListener("input",()=>{clearTimeout(delay);delay=setTimeout(()=>{offset=0;load().catch(console.error);},180);});
  pinnedCheck.addEventListener("change",()=>{offset=0;load().catch(console.error);});

  async function load() {
    const params=new URLSearchParams({q:search.value,offset:String(offset),limit:"100",pinned:pinnedCheck.checked?"1":"0"});
    const data=await request("/list?"+params);
    maxInput.value=String(data.max_entries);
    page.textContent=data.total?`${offset+1}–${Math.min(data.total,offset+100)} of ${data.total}`:"No saved prompts";
    back.disabled=offset===0;
    forward.disabled=offset+100>=data.total;
    items.replaceChildren();
    for(const item of data.items) {
      const row=document.createElement("div");row.className="ph-entry";
      const preview=document.createElement("div");preview.className="ph-preview";preview.textContent=item.text;
      preview.title=item.text;
      const metadata=document.createElement("span");metadata.className="ph-mini";
      metadata.title=`Queued ${item.queue_count}, manually saved ${item.manual_count}, executed ${item.run_count}`;
      metadata.textContent=new Date(item.updated_ms).toLocaleDateString();
      const use=makeButton("Load", "Copy this prompt into the current node",()=>{setPrompt(node,item.text);close();});
      const pin=makeButton(item.pinned?"★":"☆",item.pinned?"Unpin":"Pin",async()=>{await request("/pin",{id:item.id,pinned:!item.pinned});await load();afterChange?.();});
      const del=makeButton("✕", "Delete this history entry",async()=>{
        if(!confirm("Delete this saved prompt?"))return;
        await request("/delete",{id:item.id});
        await load();afterChange?.();
      });
      row.append(preview,metadata,use,pin,del);
      items.appendChild(row);
    }
  }
  await load();
}

function refreshAllCounters() {
  for (const fn of historyRefreshers) fn().catch(error => console.warn("Prompt History refresh", error));
}

// Successful native queue submissions have a frontend event. This is a
// fallback for canvases whose editor node was omitted from the API graph.
// The backend independently captures externally submitted jobs (sweeps, API).
api.addEventListener("promptQueued", async () => {
  const nodes = app.graph?._nodes ?? [];
  for (const node of nodes) {
    if (node.type !== "PromptHistoryText") continue;
    const linked = node.inputs?.some(input => input.name === "external_prompt" && input.link != null);
    if (linked) continue; // The real list value is only known during execution.
    const text = getPrompt(node).trim();
    if (!text) continue;
    try {
      await request("/ensure_queued", {text});
    } catch (error) {
      console.warn("Prompt History queue fallback:", error);
    }
  }
  refreshAllCounters();
});

// Refresh after server-side captures, including the LoRA Sweep Manager.
if (typeof api.addCustomEventListener === "function") {
  api.addCustomEventListener("prompt_history.updated", refreshAllCounters);
} else {
  api.addEventListener("prompt_history.updated", refreshAllCounters);
}

app.registerExtension({
  name: "prompt_history.simple",
  async beforeRegisterNodeDef(nodeType,nodeData) {
    if (nodeData.name !== "PromptHistoryText") return;
    const old = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
      const result = old?.apply(this,arguments);
      // Allow ComfyUI to finish constructing native widgets first.
      Promise.resolve(result).then(() => buildToolbar(this)).catch(e => console.error("Prompt History widget:",e));
      return result;
    };
  },
});
