import { normalizeOptions, planPacking, titleOf } from "./packing.js";
import { eligibleNodes } from "./controller.js";
import { BUILTIN_PRESETS } from "./storage.js";

function element(tag, attrs = {}, text) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") el.className = value;
    else el.setAttribute(key, value);
  }
  if (text != null) el.textContent = text;
  return el;
}
export function showPackingDialog({ nodes, metrics, state, onApply, onSave }) {
  const previous = document.querySelector("dialog.pp-dialog");
  if (previous) { previous.focus(); return; }
  const dialog = element("dialog", { class: "pp-dialog", "aria-labelledby": "pp-title" });
  const form = element("form", { class: "pp-form" });
  const header = element("header", { class: "pp-header" });
  const heading = element("div");
  heading.append(element("span", { class: "pp-eyebrow" }, "PILL PACKER"), element("h2", { id: "pp-title" }, "A little order, in one click."), element("p", {}, `${nodes.length} selected node${nodes.length === 1 ? "" : "s"} · Collapse, align, and put away.`));
  const close = element("button", { type: "button", class: "pp-close", "aria-label": "Close Pill Packer" }, "×");
  close.onclick = () => dialog.close();
  header.append(heading, close);
  const body = element("div", { class: "pp-body" });
  const controls = element("div", { class: "pp-controls" });
  const inputs = {};
  const field = (parent, label, key, config, hint) => {
    const wrapper = element("label", { class: "pp-field" });
    wrapper.append(element("span", {}, label));
    let input;
    if (Array.isArray(config)) {
      input = element("select", { name: key });
      for (const [value, name] of config) input.append(element("option", { value }, name));
    } else input = element("input", { name: key, ...config });
    inputs[key] = input;
    wrapper.append(input);
    if (hint) wrapper.append(element("small", {}, hint));
    parent.append(wrapper);
    return input;
  };
  const presets = element("div", { class: "pp-presets" });
  const presetSelect = field(presets, "Start with a preset", "preset", [["", "Custom settings"]]);
  const updatePresets = () => {
    presetSelect.replaceChildren(element("option", { value: "" }, "Custom settings"));
    for (const name of Object.keys(BUILTIN_PRESETS)) presetSelect.append(element("option", { value: `builtin:${name}` }, name));
    for (const name of Object.keys(state.presets)) presetSelect.append(element("option", { value: `saved:${name}` }, `${name} · saved`));
  };
  updatePresets();
  controls.append(presets);
  const layoutSection = element("fieldset");
  layoutSection.append(element("legend", {}, "Arrangement"));
  field(layoutSection, "Layout", "layout", [["type","A stack per node type"],["category","A stack per category"],["stack","One vertical stack"],["columns","Balanced columns"]]);
  const columnField = field(layoutSection, "Columns", "columns", { type:"number", min:1, max:20, step:1 }).parentElement;
  field(layoutSection, "Node order", "order", [["visual","Current visual order"],["title","Title"],["type","Node type"],["connections","Connection order"]]);
  const gaps = element("div", { class:"pp-pair" });
  field(gaps, "Vertical gap", "gapY", { type:"number", min:0, max:20, step:1 });
  field(gaps, "Column gap", "gapX", { type:"number", min:0, max:40, step:1 });
  layoutSection.append(gaps, element("small", {class:"pp-hint"}, `Distances are in grid units (${metrics.grid}px each). Positions snap to the grid.`));
  controls.append(layoutSection);
  const widths = element("fieldset");
  widths.append(element("legend", {}, "Pill widths"));
  field(widths, "Width mode", "width", [["fit","Fit each title"],["stack","Same width within each stack"],["selection","Same width across selection"],["fixed","Fixed width"]]);
  const widthPair = element("div", {class:"pp-pair"});
  field(widthPair,"Minimum", "minWidth", {type:"number",min:3,max:100,step:1});
  const capField = field(widthPair,"Maximum", "maxWidth", {type:"number",min:0,max:100,step:1}, "0 = no limit").parentElement;
  widths.append(widthPair);
  const fixedField = field(widths,"Fixed width", "fixedWidth", {type:"number",min:3,max:100,step:1}).parentElement;
  const titleMinLabel = element("label",{class:"pp-check"});
  inputs.minWidthFromTitle = element("input",{type:"checkbox",name:"minWidthFromTitle"});
  titleMinLabel.append(inputs.minWidthFromTitle, document.createTextNode("Minimum fits longest title in each stack"));
  widths.append(titleMinLabel,element("small",{class:"pp-hint pp-title-min-hint"},"Includes room for controls. This minimum can exceed Maximum or Fixed width."));
  widths.append(element("small",{class:"pp-hint"},"Widths use grid units. Long titles are shortened visually; full node titles are preserved."));
  controls.append(widths);
  const finishing = element("fieldset");
  finishing.append(element("legend",{},"Finishing touches"));
  field(finishing,"Colors", "color", [["preserve","Keep existing colors"],["type","Color by node type"],["category","Color by category"],["stack","Color by stack"]]);
  field(finishing,"Groups", "grouping", [["none","Leave groups as they are"],["single","Wrap selection in a group"],["stacks","A group around each stack"],["existing","Fit existing containing group"]]);
  const groupTitleField = field(finishing,"Group title", "groupTitle", {type:"text",maxlength:120}).parentElement;
  const paddingField = field(finishing,"Group padding", "padding", {type:"number",min:0,max:20,step:1}).parentElement;
  const pinLabel = element("label",{class:"pp-check"});
  inputs.skipPinned = element("input",{type:"checkbox",name:"skipPinned"});
  pinLabel.append(inputs.skipPinned, document.createTextNode("Leave pinned nodes in place"));
  finishing.append(pinLabel); controls.append(finishing);
  const previewPanel = element("aside",{class:"pp-preview-panel","aria-label":"Packing preview"});
  previewPanel.append(element("span",{class:"pp-eyebrow"},"LAYOUT PREVIEW"));
  const preview = element("div",{class:"pp-preview"});
  const summary = element("p",{class:"pp-summary","aria-live":"polite"});
  previewPanel.append(preview,summary,element("p",{class:"pp-note"},"Expanded, collapsed, or mixed: every included node becomes a pill. Expanded sizes and connections are preserved."));
  const saveBox = element("div",{class:"pp-save-box"});
  const presetName = element("input",{type:"text",placeholder:"Name this preset…",maxlength:60,"aria-label":"Preset name"});
  const saveButton = element("button",{type:"button",class:"pp-secondary"},"Save preset");
  const deleteButton = element("button",{type:"button",class:"pp-text-button"},"Delete saved preset");
  deleteButton.hidden = true;
  saveBox.append(presetName,saveButton,deleteButton); previewPanel.append(saveBox);
  body.append(controls,previewPanel);
  const footer = element("footer",{class:"pp-footer"});
  const status = element("p",{class:"pp-status",role:"status"},"One undo restores the whole operation.");
  const actions = element("div",{class:"pp-actions"});
  const cancel = element("button",{type:"button",class:"pp-secondary"},"Cancel");
  cancel.onclick = () => dialog.close();
  const pack = element("button",{type:"submit",class:"pp-primary"},"Pack selection");
  actions.append(cancel,pack); footer.append(status,actions);
  form.append(header,body,footer); dialog.append(form); document.body.append(dialog);

  function read() {
    const values = {};
    for (const key of Object.keys(state.options)) {
      if (!inputs[key]) continue;
      values[key] = inputs[key].type === "checkbox" ? inputs[key].checked : inputs[key].value;
    }
    return normalizeOptions(values);
  }
  function fill(options) {
    for (const [key,value] of Object.entries(normalizeOptions(options))) {
      if (!inputs[key]) continue;
      if (inputs[key].type === "checkbox") inputs[key].checked = value;
      else inputs[key].value = String(value);
    }
    render();
  }
  function render() {
    const options = read();
    columnField.hidden = options.layout !== "columns";
    fixedField.hidden = options.width !== "fixed";
    capField.hidden = options.width === "fixed";
    paddingField.hidden = options.grouping === "none";
    groupTitleField.hidden = !["single","stacks"].includes(options.grouping);
    const included = eligibleNodes(nodes,options);
    const plan = planPacking(included,options,metrics);
    preview.replaceChildren();
    pack.disabled = !included.length;
    const skipped = nodes.length-included.length;
    summary.textContent = `${included.length} pill${included.length===1?"":"s"} · ${plan.stacks.length} stack${plan.stacks.length===1?"":"s"}${skipped?` · ${skipped} skipped`:""}`;
    if (!plan.bounds) { preview.append(element("p",{},"No movable, collapsible nodes in this selection.")); return; }
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns,"svg");
    const b = plan.bounds, margin = metrics.grid*2;
    svg.setAttribute("viewBox",`${b.x-margin} ${b.y-margin} ${b.width+margin*2} ${b.height+margin*2}`);
    svg.setAttribute("role","img"); svg.setAttribute("aria-label",summary.textContent);
    const defs = document.createElementNS(ns,"defs"); svg.append(defs);
    for (const [i,e] of plan.entries.entries()) {
      const clip = document.createElementNS(ns,"clipPath"); clip.id=`pp-clip-${i}`;
      const clipRect = document.createElementNS(ns,"rect");
      for (const [key,value] of Object.entries({x:e.x+metrics.titleHeight,y:e.y,width:Math.max(0,e.width-metrics.titleHeight*1.5),height:e.height})) clipRect.setAttribute(key,value);
      clip.append(clipRect); defs.append(clip);
      const pill = document.createElementNS(ns,"rect");
      for (const [key,value] of Object.entries({x:e.x,y:e.y,width:e.width,height:e.height,rx:Math.min(12,e.height/3),fill:e.colors?.color || e.node.color || "#575266"})) pill.setAttribute(key,value);
      const title = document.createElementNS(ns,"title"); title.textContent=titleOf(e.node); pill.append(title); svg.append(pill);
      for (const edge of [0,e.width]) {
        const dot = document.createElementNS(ns,"circle");
        for (const [key,value] of Object.entries({cx:e.x+edge,cy:e.y+e.height/2,r:3,fill:"#b1c5b1"})) dot.setAttribute(key,value);
        svg.append(dot);
      }
      const text = document.createElementNS(ns,"text");
      for (const [key,value] of Object.entries({x:e.x+metrics.titleHeight,y:e.y+e.height/2,"dominant-baseline":"central","font-size":14,fill:"#fff","clip-path":`url(#pp-clip-${i})`})) text.setAttribute(key,value);
      text.textContent=titleOf(e.node); svg.append(text);
    }
    preview.append(svg);
  }
  for (const [key,input] of Object.entries(inputs)) {
    if (key === "preset") continue;
    input.addEventListener("input",()=>{ presetSelect.value=""; deleteButton.hidden=true; render(); });
  }
  presetSelect.onchange=()=>{
    const value=presetSelect.value;
    if (value.startsWith("builtin:")) fill(BUILTIN_PRESETS[value.slice(8)]);
    else if (value.startsWith("saved:")) { fill(state.presets[value.slice(6)]); presetName.value=value.slice(6); }
    deleteButton.hidden=!value.startsWith("saved:");
  };
  saveButton.onclick=()=>{
    const name=presetName.value.trim();
    if (!name || ["__proto__","constructor","prototype"].includes(name)) { status.textContent="Enter a name for your preset."; presetName.focus(); return; }
    state.presets[name]=read();
    const saved=onSave(state);
    updatePresets(); presetSelect.value=`saved:${name}`; deleteButton.hidden=false;
    status.textContent=saved?`Saved “${name}”.`:"Your browser could not save this preset.";
  };
  deleteButton.onclick=()=>{
    if (!presetSelect.value.startsWith("saved:")) return;
    delete state.presets[presetSelect.value.slice(6)]; onSave(state); updatePresets(); deleteButton.hidden=true;
    status.textContent="Preset deleted.";
  };
  form.onsubmit=(event)=>{
    event.preventDefault();
    if (!form.reportValidity()) return;
    try {
      onApply(read()); dialog.close();
    } catch (error) { status.textContent=error.message; status.classList.add("pp-error"); }
  };
  dialog.addEventListener("keydown",event=>{
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); dialog.close(); }
  });
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});
  fill(state.options); dialog.showModal();
  return dialog;
}
