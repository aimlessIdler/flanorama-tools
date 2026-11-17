import { app } from "../../scripts/app.js";
import { PROPERTY } from "./packing.js";
import { applyPacking, graphEdges, resetWidths, selectionOf, isNode } from "./controller.js";
import { createDOMBridge, installNodeRenderer } from "./renderer.js";
import { showPackingDialog } from "./dialog.js";
import { loadState, saveState } from "./storage.js";

const ID="PillPacker";
let bridge, state;
const watched=new WeakSet();
const litegraph=()=>globalThis.LiteGraph || globalThis.__COMFY_LITEGRAPH_INSTANCE__;
const groupClass=()=>globalThis.LGraphGroup || litegraph()?.LGraphGroup;

function notice(message, severity="info") {
  const toast=app.extensionManager?.toast;
  if (toast?.add) toast.add({severity,summary:"Pill Packer",detail:message,life:5000});
  else {
    let el=document.querySelector(".pp-toast");
    if (!el) { el=document.createElement("div"); el.className="pp-toast"; el.setAttribute("role","status"); document.body.append(el); }
    el.textContent=message; setTimeout(()=>el.remove(),6000);
  }
}
function context(fallback) {
  const canvas=app.canvas, graph=canvas?.graph;
  if (!canvas || !graph || !litegraph()) throw new Error("The workflow canvas is not ready yet.");
  if (canvas.read_only) throw new Error("This workflow is read-only.");
  const nodes=selectionOf(canvas,fallback);
  if (!nodes.length) throw new Error("Select the nodes you want to pack first.");
  return {canvas,graph,nodes};
}
function execute(ctx,options,metrics) {
  if (app.canvas.graph!==ctx.graph) throw new Error("The workflow changed. Close this dialog and select the nodes again.");
  const result=applyPacking({...ctx,options,metrics:metrics || bridge.metrics(ctx.nodes,litegraph()),litegraph:litegraph(),Group:groupClass(),bridge});
  state.options=result.plan.options;
  const saved=saveState(state);
  notice(`Packed ${result.count} node${result.count===1?"":"s"}${result.skipped?`; ${result.skipped} skipped`:""}.${saved?"":" Browser settings could not be saved."}`);
  return result;
}
function open(fallback) {
  try {
    state=loadState();
    const ctx=context(fallback), metrics={...bridge.metrics(ctx.nodes,litegraph()),edges:graphEdges(ctx.graph)};
    showPackingDialog({nodes:ctx.nodes,metrics,state,onSave:saveState,onApply:options=>execute(ctx,options,metrics)});
  } catch(error) {notice(error.message,"warn");}
}
function repeat() {
  try {state=loadState(); execute(context(),state.options);}
  catch(error) {notice(error.message,"warn");}
}
function clear(fallback) {
  try {const count=resetWidths({...context(fallback),bridge}); notice(`Restored natural collapsed widths for ${count} node${count===1?"":"s"}.`);}
  catch(error) {notice(error.message,"warn");}
}
function watchNode(node) {
  if (watched.has(node)) return;
  watched.add(node);
  const configure=node.onConfigure;
  node.onConfigure=function(...args) {
    const result=configure?.apply(this,args);
    if (this.properties?.[PROPERTY]) installNodeRenderer(this,litegraph());
    bridge?.schedule();
    return result;
  };
  if (typeof app.collectNodeMenuItems !== "function") {
    const extra=node.getExtraMenuOptions;
    node.getExtraMenuOptions=function(canvas,options) {
      const result=extra?.call(this,canvas,options);
      options.push(...menu(this));
      return result;
    };
  }
  if (node.properties?.[PROPERTY]) installNodeRenderer(node,litegraph());
}
const menu=node=>[{
  content:"Pill Packer",submenu:{options:[
    {content:"Pack selection…",callback:()=>open(node)},
    {content:"Pack with last settings",callback:()=>{
      try {state=loadState(); execute(context(node),state.options);} catch(error){notice(error.message,"warn");}
    }},
    {content:"Restore natural collapsed widths",callback:()=>clear(node)},
  ]},
}];

app.registerExtension({
  name:"comfyui.PillPacker",
  commands:[
    {id:`${ID}.Open`,label:"Pill Packer: Pack selection…",icon:"icon-[lucide--align-start-vertical]",function:()=>open()},
    {id:`${ID}.Repeat`,label:"Pill Packer: Pack with last settings",icon:"icon-[lucide--repeat]",function:repeat},
    {id:`${ID}.ResetWidths`,label:"Pill Packer: Restore natural collapsed widths",function:()=>clear()},
  ],
  keybindings:[
    {combo:{key:"p",alt:true,shift:true},commandId:`${ID}.Open`},
  ],
  menuCommands:[{path:["Edit","Pill Packer"],commands:[`${ID}.Open`,`${ID}.Repeat`,`${ID}.ResetWidths`]}],
  getSelectionToolboxCommands:item=>isNode(item)?[`${ID}.Open`,`${ID}.Repeat`]:[],
  getNodeMenuItems:node=>menu(node),
  getCanvasMenuItems:()=>menu(),
  setup() {
    if (!document.getElementById("pill-packer-css")) {
      const link=document.createElement("link"); link.id="pill-packer-css"; link.rel="stylesheet";
      link.href=new URL("./pill-packer.css",import.meta.url).href; document.head.append(link);
    }
    state=loadState(); bridge=createDOMBridge(app); bridge.start();
    if (typeof app.collectCanvasMenuItems !== "function") {
      const extra=app.canvas.getExtraMenuOptions;
      app.canvas.getExtraMenuOptions=function(canvas,options) {
        const result=extra?.call(this,canvas,options);
        options.push(...menu());
        return result;
      };
    }
    for (const node of app.canvas?.graph?._nodes || []) watchNode(node);
  },
  nodeCreated:watchNode,
  loadedGraphNode:watchNode,
  afterConfigureGraph() {bridge?.schedule();},
  afterLoadGraph() {bridge?.schedule();},
});
