import assert from "node:assert/strict";
import test from "node:test";
import * as c from "../web/timeline_core.js";

test("isLink distinguishes wiring from values", () => {
  assert.equal(c.isLink(["9", 0]), true);
  assert.equal(c.isLink([9, 0]), false);
  assert.equal(c.isLink(["a", "b"]), false);
  assert.equal(c.isLink([1, 2, 3]), false);
  assert.equal(c.isLink("x"), false);
});

test("formatValue", () => {
  assert.deepEqual(c.formatValue(["12", 1]), { text: "← node 12 (slot 1)", full: "← node 12 (slot 1)", link: true });
  assert.equal(c.formatValue(7.5).text, "7.5");
  assert.equal(c.formatValue(undefined).text, "(absent)");
  assert.equal(c.formatValue(true).text, "true");
  const long = "x".repeat(300);
  const f = c.formatValue(long, 50);
  assert.equal(f.text.length, 50);
  assert.equal(f.full, long);
});

test("relativeTime", () => {
  const now = 1_000_000_000;
  assert.equal(c.relativeTime(now - 10_000, now), "just now");
  assert.equal(c.relativeTime(now - 5 * 60_000, now), "5 min ago");
  assert.equal(c.relativeTime(now - 3 * 3600_000, now), "3 h ago");
  assert.equal(c.relativeTime(now - 2 * 86400_000, now), "2 d ago");
  assert.equal(c.relativeTime(now + 5000, now), "just now");
});

test("viewQuery encodes literal percent signs and backslashes", () => {
  const q = c.viewQuery({ filename: "expel-%date%_00652_.png", subfolder: "markita-pw\\expelled", type: "output" });
  const p = new URLSearchParams(q);
  assert.equal(p.get("filename"), "expel-%date%_00652_.png");
  assert.equal(p.get("subfolder"), "markita-pw\\expelled");
  assert.match(q, /%25date%25/);
  assert.equal(new URLSearchParams(c.viewQuery({ filename: "a.png" })).get("type"), "output");
});

test("mediaKind", () => {
  assert.equal(c.mediaKind({ kind: "images", filename: "a.png" }), "image");
  assert.equal(c.mediaKind({ kind: "gifs", filename: "a.mp4" }), "video");
  assert.equal(c.mediaKind({ kind: "gifs", filename: "a.gif" }), "image");
  assert.equal(c.mediaKind({ kind: "audio", filename: "a.flac" }), "file");
});

test("planRestore skips links and widgetless params", () => {
  const plan = c.planRestore({ seed: 5, cfg: 7, model: ["4", 0], hidden: 1 }, ["seed", "cfg"]);
  assert.deepEqual(plan.restorable, [{ param: "seed", value: 5 }, { param: "cfg", value: 7 }]);
  assert.deepEqual(plan.skipped, [{ param: "model", reason: "link" }, { param: "hidden", reason: "no widget" }]);
  assert.deepEqual(c.planRestore(null, []), { restorable: [], skipped: [] });
});

test("badgeInfo only appears for nodes with history", () => {
  assert.equal(c.badgeInfo(undefined), null);
  assert.equal(c.badgeInfo({ states: 1, changed_in_latest: false }), null);
  assert.deepEqual(c.badgeInfo({ states: 4, changed_in_latest: true }), { label: "4", changed: true });
});

test("badge geometry and hit testing", () => {
  const r = c.badgeRect(300, 30, "12");
  assert.ok(r.y < 0 && r.y + r.h <= 0);
  assert.ok(r.x + r.w <= 300);
  assert.equal(c.inRect(r, r.x + 1, r.y + 1), true);
  assert.equal(c.inRect(r, r.x - 1, r.y + 1), false);
  assert.equal(c.inRect(r, r.x + 1, 5), false);
});

test("literal diffs report changed leaf values for arbitrary node state", () => {
  const old = {sizes:[[1280,1280],[1080,1920]],selected:0,orientation:"portrait",w:1280,h:1280};
  const next = {...old,selected:1,orientation:"landscape",w:1920,h:1080};
  const changes = c.readableChanges([{param:"SizesState",old:JSON.stringify(old),new:JSON.stringify(next)}]);
  assert.deepEqual(changes.map(x => [x.param,x.old,x.new]), [
    ["SizesState.selected",0,1], ["SizesState.orientation","portrait","landscape"],
    ["SizesState.w",1280,1920], ["SizesState.h",1280,1080],
  ]);
  const weight = c.readableChanges([{param:"config",old:'{"weight":1.2,"enabled":true}',new:'{"weight":1.3,"enabled":true}'}]);
  assert.deepEqual(weight, [{param:"config.weight",old:1.2,new:1.3,source:"config",hasOld:true,hasNew:true}]);
  const arrays = c.readableChanges([{param:"state",old:{items:[1,2]},new:{items:[1,3,4]}}]);
  assert.deepEqual(arrays.map(x => [x.param,x.old,x.new]), [
    ["state.items[1]",2,3], ["state.items[2]",undefined,4],
  ]);
  assert.deepEqual(c.readableChanges([{param:"json",old:'{"a":1}',new:'{ "a": 1 }'}]), []);
  const removed = c.readableChanges([{param:"state",old:{a:null,b:1},new:{b:1}}]);
  assert.equal(removed[0].param,"state.a");
  assert.equal(removed[0].hasOld,true);
  assert.equal(removed[0].hasNew,false);
  assert.deepEqual(c.readableChanges([{param:"input",old:["1",0],new:["2",0]}]).map(x => x.param), ["input"]);
});
