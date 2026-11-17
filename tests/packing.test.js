import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, normalizeOptions, planPacking, orderedNodes, colorFor } from "../web/packing.js";
import { ellipsize, installNodeRenderer, packedWidth } from "../web/renderer.js";
import { selectionOf, applyPacking, resetWidths } from "../web/controller.js";
import { loadState, saveState } from "../web/storage.js";

function node(id, type = "Seed", x = 100, y = id * 100, collapsed = false) {
  return { id, type, title: `${type} ${id}`, pos:[x,y], size:[300,150], flags:{collapsed}, properties:{},
    collapse() {this.flags.collapsed=!this.flags.collapsed;}, getTitle() {return this.title;},
    measure(out) {this._collapsed_width=99; out.splice(0,4,this.pos[0],this.pos[1]-30,this._collapsed_width,30);},
    get renderingSize() {return this.flags.collapsed?[this._collapsed_width || 99,0]:this.size;},
  };
}
function fixture(nodes) {
  const events=[];
  const graph={_nodes:nodes,_groups:[],links:new Map(),
    beforeChange(){events.push("graph-before");},afterChange(){events.push("graph-after");},change(){},
    add(g){g.id=this._groups.length+1;this._groups.push(g);},remove(g){this._groups=this._groups.filter(x=>x!==g);}};
  nodes.forEach(n=>n.graph=graph);
  const canvas={graph,emitBeforeChange(){events.push("canvas-before");},emitAfterChange(){events.push("canvas-after");},setDirty(){}};
  class Group {
    static minWidth=140;static minHeight=80;
    constructor(title){this.title=title;this.pos=[0,0];this.size=[140,80];this.flags={};}
    serialize(){return {title:this.title,pos:[...this.pos],size:[...this.size],flags:structuredClone(this.flags)};}
    configure(data){Object.assign(this,data);}
  }
  return {graph,canvas,nodes,Group,events,litegraph:{NODE_TITLE_HEIGHT:30},metrics:{grid:20,titleHeight:30,measureTitle:n=>n.type==="Long"?340:130}};
}

test("mixed states are collapsed, expanded dimensions and workflow values stay intact",()=>{
  const a=node(1), b=node(2,"Long",300,200,true);a.widgets=[{value:123}];
  const ctx=fixture([a,b]);
  const sizes=ctx.nodes.map(n=>[...n.size]);
  applyPacking({...ctx,options:{width:"selection"}});
  assert.ok(ctx.nodes.every(n=>n.flags.collapsed));
  assert.deepEqual(ctx.nodes.map(n=>n.size),sizes);
  assert.equal(a.widgets[0].value,123);
  assert.equal(packedWidth(a),340);assert.equal(packedWidth(b),340);
  assert.deepEqual(ctx.events,["canvas-before","graph-before","graph-after","canvas-after"]);
});
test("repeat packing is stable for all layouts and ordering modes",()=>{
  for(const layout of ["type","category","columns","stack"]) for(const order of ["visual","type","title","connections"]){
    const nodes=[node(1,"B",340,171),node(2,"A",110,303),node(3,"B",240,503),node(4,"A",123,215)];
    const ctx=fixture(nodes), options={layout,order};
    applyPacking({...ctx,options});
    const first=nodes.map(n=>[...n.pos]);
    applyPacking({...ctx,options});
    assert.deepEqual(nodes.map(n=>n.pos),first,`${layout} / ${order}`);
  }
});
test("every requested column is used with balanced counts",()=>{
  const plan=planPacking(Array.from({length:5},(_,i)=>node(i)),{layout:"columns",columns:4});
  assert.deepEqual(plan.stacks.map(s=>s.nodes.length),[2,1,1,1]);
});
test("width modes, cap, no-cap, and fixed width respect the grid",()=>{
  const nodes=[node(1,"Short"),node(2,"Short"),node(3,"Long")];
  const metrics={grid:20,measureTitle:n=>n.id===1?141:n.id===2?201:600};
  assert.deepEqual(planPacking(nodes,{width:"fit"},metrics).entries.map(e=>e.width),[160,220,480]);
  assert.deepEqual(planPacking(nodes,{width:"stack"},metrics).entries.map(e=>e.width),[220,220,480]);
  assert.ok(planPacking(nodes,{width:"selection",maxWidth:0},metrics).entries.every(e=>e.width===600));
  assert.ok(planPacking(nodes,{width:"fixed",fixedWidth:8},metrics).entries.every(e=>e.width===160));
});
test("grid distance gives at least the requested edge-to-edge gap",()=>{
  const p=planPacking([node(1),node(2)],{layout:"stack",gapY:2},{grid:20,pillHeight:34});
  assert.ok(p.entries[1].y-p.entries[0].y-p.entries[0].height>=40);
  assert.equal(p.entries[1].y%20,0);
});
test("tiny grid-based width limits still leave room for controls",()=>{
  for (const width of ["fit","fixed"]) {
    const p=planPacking([node(1)],{width,minWidth:3,maxWidth:3,fixedWidth:3},{grid:10,titleHeight:30,measureTitle:()=>15});
    assert.equal(p.entries[0].width,60);
  }
});
test("equal titles and types do not reshuffle on repeat",()=>{
  for (const order of ["title","type","connections","visual"]) {
    const nodes=Array.from({length:8},(_,i)=>node(i,"Seed",(i%3)*123,Math.floor(i/3)*99));
    nodes.forEach(n=>n.title="Seed");
    const ctx=fixture(nodes),options={layout:"columns",columns:3,order};
    applyPacking({...ctx,options});const first=nodes.map(n=>[...n.pos]);
    applyPacking({...ctx,options});assert.deepEqual(nodes.map(n=>n.pos),first);
  }
});
test("connection order handles duplicate edges, cycles, and missing nodes",()=>{
  const nodes=[node(1),node(2),node(3),node(4)];
  assert.deepEqual(orderedNodes(nodes,"connections",[[3,2],[3,2],[2,1],[999,4]]).map(n=>n.id),[3,2,1,4]);
  assert.equal(new Set(orderedNodes(nodes,"connections",[[1,2],[2,1]]).map(n=>n.id)).size,4);
});
test("pinned and noncollapsible nodes are skipped; explicit unpin policy works",()=>{
  const nodes=[node(1),node(2)];nodes[1].flags.pinned=true;
  const ctx=fixture(nodes), original=[...nodes[1].pos];
  const result=applyPacking({...ctx,options:DEFAULTS});
  assert.equal(result.skipped,1);assert.deepEqual(nodes[1].pos,original);assert.equal(nodes[1].flags.collapsed,false);
  applyPacking({...ctx,options:{skipPinned:false}});assert.equal(nodes[1].flags.collapsed,true);
});
test("a throwing custom node rolls back prior moves, widths, collapse flags and colors",()=>{
  const nodes=[node(1),node(2)];nodes[0].color="#abc";nodes[1].collapse=()=>{throw new Error("custom failure");};
  const before=nodes.map(n=>({pos:[...n.pos],flags:{...n.flags},color:n.color}));
  const ctx=fixture(nodes);
  assert.throws(()=>applyPacking({...ctx,options:{color:"type",grouping:"single"}}),/custom failure/);
  assert.deepEqual(nodes.map(n=>({pos:n.pos,flags:n.flags,color:n.color})),before);
  assert.ok(nodes.every(n=>!n.properties.pill_packer));assert.equal(ctx.graph._groups.length,0);
  assert.equal(ctx.events.at(-1),"canvas-after");
});
test("groups are reused on repeat and per-stack group bounds do not overlap",()=>{
  const ctx=fixture([node(1,"A"),node(2,"B")]);
  const options={grouping:"stacks",padding:2,gapX:0,minWidth:3};
  applyPacking({...ctx,options});applyPacking({...ctx,options});
  assert.equal(ctx.graph._groups.length,2);
  const [a,b]=ctx.graph._groups;
  assert.ok(a.pos[0]+a.size[0]<b.pos[0]);
});
test("fitting an existing group preserves other node contents and rejects pinned groups",()=>{
  const a=node(1,"A",100,120),b=node(2,"B",700,400),ctx=fixture([a,b]);
  const group=new ctx.Group("Keep my title");group.pos=[50,50];group.size=[1100,600];ctx.graph.add(group);
  const otherPos=[...b.pos];
  applyPacking({...ctx,nodes:[a],options:{grouping:"existing"}});
  assert.equal(group.title,"Keep my title");assert.deepEqual(b.pos,otherPos);
  assert.ok(group.pos[0]+group.size[0]>=b.pos[0]+b.size[0]);
  assert.ok(group.pos[1]+group.size[1]>=b.pos[1]+b.size[1]);
  group.flags.pinned=true;
  assert.throws(()=>applyPacking({...ctx,nodes:[a],options:{grouping:"existing"}}),/unlocked group/);
});
test("packing an active subgraph does not mutate the parent graph",()=>{
  const parent=fixture([node(10)]),sub=fixture([node(1),node(2)]);
  const before=[...parent.nodes[0].pos];
  applyPacking({...sub,options:{grouping:"single"}});
  assert.deepEqual(parent.nodes[0].pos,before);assert.equal(parent.graph._groups.length,0);
  assert.equal(sub.graph._groups.length,1);
});
test("reset width restores natural renderer and leaves expanded size unchanged",()=>{
  const a=node(1),ctx=fixture([a]);
  applyPacking({...ctx,options:{width:"fixed",fixedWidth:20}});
  const out=[];a.measure(out);assert.equal(out[2],400);assert.equal(a.renderingSize[0],400);
  resetWidths(ctx);a.measure(out);assert.equal(out[2],99);assert.deepEqual(a.size,[300,150]);
  a.flags.collapsed=false;assert.deepEqual(a.renderingSize,[300,150]);
});
test("repacking a node with reactive width properties does not need structuredClone",()=>{
  const a=node(1),ctx=fixture([a]);
  applyPacking({...ctx,options:{color:"preserve"}});
  a.properties.pill_packer=new Proxy(a.properties.pill_packer,{});
  assert.doesNotThrow(()=>applyPacking({...ctx,options:{color:"preserve"}}));
  assert.doesNotThrow(()=>applyPacking({...ctx,options:{color:"type"}}));
});
test("reactive nested group metadata can be snapshotted and rolled back",()=>{
  const a=node(1),ctx=fixture([a]),group=new ctx.Group("Existing");
  group.flags=new Proxy({pill_packer:new Proxy({key:"all",nodes:new Proxy(["1"],{})},{})},{});
  group.serialize=()=>new Proxy({title:group.title,pos:[...group.pos],size:[...group.size],flags:group.flags},{});
  ctx.graph.add(group);
  assert.doesNotThrow(()=>applyPacking({...ctx,options:{grouping:"single",color:"type"}}));
  const before=JSON.parse(JSON.stringify(group.serialize())),position=[...a.pos];
  const bridge={sync(){throw new Error("test rollback");}};
  assert.throws(()=>applyPacking({...ctx,bridge,options:{grouping:"single",color:"category"}}),/test rollback/);
  assert.deepEqual(JSON.parse(JSON.stringify(group.serialize())),before);
  assert.deepEqual(a.pos,position);
});
test("longest-title minimum exceeds caps and small fixed widths within each stack",()=>{
  const nodes=[node(1,"Short"),node(2,"Short"),node(3,"Long")];
  const metrics={grid:20,measureTitle:n=>n.id===1?141:n.id===2?321:650};
  for(const width of ["fit","stack","fixed"]){
    const plan=planPacking(nodes,{width,fixedWidth:8,minWidthFromTitle:true,maxWidth:10},metrics);
    assert.deepEqual(plan.entries.map(e=>e.width),[340,340,660]);
  }
  const common=planPacking(nodes,{width:"selection",minWidthFromTitle:true,maxWidth:10},metrics);
  assert.ok(common.entries.every(e=>e.width===660));
});
test("packed default titles stay bright while canvas alpha and custom colors are preserved",()=>{
  const a=node(1);a.flags.collapsed=true;a.properties.pill_packer={width:240};
  a.drawTitleText=function(ctx){this.onDrawTitleText?.(ctx);};
  const draws=[],stack=[];
  const ctx={fillStyle:"#123",globalAlpha:.6,font:"14px Arial",save(){stack.push({fillStyle:this.fillStyle,globalAlpha:this.globalAlpha});},restore(){Object.assign(this,stack.pop());},beginPath(){},rect(){},clip(){},measureText:s=>({width:s.length*8}),fillText(s){draws.push({text:s,color:this.fillStyle,alpha:this.globalAlpha});}};
  installNodeRenderer(a,{});
  a.drawTitleText(ctx,{default_title_color:"#999"});
  assert.equal(draws[0].color,"#fff");assert.equal(draws[0].alpha,.6);
  assert.equal(ctx.fillStyle,"#123");assert.equal(ctx.globalAlpha,.6);
  a.onDrawTitleText=function(ctx){ctx.fillStyle="#81c0ff";ctx.fillText("custom");};
  a.drawTitleText(ctx,{default_title_color:"#999"});
  assert.equal(draws[1].color,"#81c0ff");
});
test("saved width installs on reloaded nodes and follows property changes for undo",()=>{
  const a=node(1);a.flags.collapsed=true;a.properties.pill_packer={width:400};
  installNodeRenderer(a,{});assert.equal(a.renderingSize[0],400);
  a.properties.pill_packer={width:200};assert.equal(a.renderingSize[0],200);
  delete a.properties.pill_packer;assert.equal(a.renderingSize[0],99);
});
test("selection supports modern sets, legacy dictionaries, and context menus",()=>{
  const a=node(1),b=node(2),group={id:99};
  assert.deepEqual(selectionOf({selectedItems:new Set([a,group,b])}),[a,b]);
  assert.deepEqual(selectionOf({selected_nodes:{1:a}}),[a]);
  assert.deepEqual(selectionOf({selectedItems:new Set([a])},b),[b]);
});
test("read-only and stale graph operations refuse to mutate",()=>{
  const a=node(1),ctx=fixture([a]);ctx.canvas.read_only=true;
  assert.throws(()=>applyPacking({...ctx,options:{}}),/read-only/);
  assert.throws(()=>resetWidths(ctx),/read-only/);
  ctx.canvas.read_only=false;a.graph={};
  assert.throws(()=>applyPacking({...ctx,options:{}}),/workflow changed/);
  assert.equal(a.flags.collapsed,false);
});
test("normalization and storage survive malformed preferences and storage failures",()=>{
  assert.deepEqual(normalizeOptions(null),DEFAULTS);
  const options=normalizeOptions({columns:NaN,gapY:-2,maxWidth:1,minWidth:10,layout:"evil"});
  assert.equal(options.columns,3);assert.equal(options.gapY,0);assert.equal(options.maxWidth,10);
  assert.deepEqual(loadState({getItem:()=>"{"}).options,DEFAULTS);
  assert.deepEqual(loadState({getItem:()=>"null"}).options,DEFAULTS);
  assert.equal(saveState({}, {setItem(){throw new Error("full");}}),false);
});
test("ellipses fit measured space and preserve unicode code points",()=>{
  const ctx={measureText:s=>({width:Array.from(s).length*10})};
  assert.equal(ellipsize(ctx,"A😀BC",30),"A😀…");
  assert.equal(ellipsize(ctx,"AB",5),"");
});
test("type colors are deterministic and valid hex colors",()=>{
  assert.deepEqual(colorFor("Seed"),colorFor("Seed"));
  assert.match(colorFor("Seed").color,/^#[0-9a-f]{6}$/);
});
