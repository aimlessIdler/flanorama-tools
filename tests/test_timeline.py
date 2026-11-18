"""Standalone tests for the event log; ComfyUI itself is not required."""
import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from aiohttp import web

ROOT=Path(__file__).resolve().parents[1]

class RouteStub:
    def __init__(self): self.handlers={}
    def get(self,path):
        def decorator(fn): self.handlers[("GET",path)] = fn;return fn
        return decorator
    def post(self,path):
        def decorator(fn): self.handlers[("POST",path)] = fn;return fn
        return decorator

routes=RouteStub()
server=types.ModuleType("server")
server.PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes,app=web.Application()))
sys.modules["server"]=server
folder_paths=types.ModuleType("folder_paths")
_user_dir = tempfile.TemporaryDirectory()
folder_paths.get_user_directory=lambda: _user_dir.name
sys.modules["folder_paths"]=folder_paths
spec=importlib.util.spec_from_file_location("_prompt_history_tl",ROOT/"prompt_history.py", submodule_search_locations=[str(ROOT)])
ph=importlib.util.module_from_spec(spec)
sys.modules["_prompt_history_tl"]=ph
spec.loader.exec_module(ph)
tl=sys.modules["_prompt_history_tl.timeline"]


def tearDownModule():
    ph.STORE.conn.close()
    _user_dir.cleanup()


def graph(seed=1, cfg=7.0, text="a cat", lora=0.8, extra=False):
    g={
        "1":{"class_type":"CLIPTextEncode","inputs":{"text":text,"clip":["9",0]},"_meta":{"title":"Positive"}},
        "2":{"class_type":"KSampler","inputs":{"seed":seed,"cfg":cfg,"positive":["1",0]},"_meta":{"title":"Sampler"}},
        "3":{"class_type":"LoraLoader","inputs":{"strength_model":lora}},
        "4":{"class_type":"SaveImage","inputs":{"images":["2",0]}},
    }
    if extra: g["5"]={"class_type":"ImageScale","inputs":{"width":512}}
    return g

class TestTimeline(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.db=ph.HistoryStore(Path(self.tmp.name)/"history.sqlite3")
        self.t=self.db.timeline
    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def test_hash_is_stable_and_order_independent(self):
        a=tl.compute_state_hash("K",{"a":1,"b":[2,3]})
        b=tl.compute_state_hash("K",{"b":[2,3],"a":1})
        self.assertEqual(a,b)
        self.assertNotEqual(a,tl.compute_state_hash("K",{"a":2,"b":[2,3]}))
        self.assertNotEqual(a,tl.compute_state_hash("L",{"a":1,"b":[2,3]}))

    def test_record_event_idempotent_and_dedupes_states(self):
        e1=self.t.record_event("p1",graph(),"wf")
        self.assertEqual(self.t.record_event("p1",graph(),"wf"),e1)
        self.t.record_event("p2",graph(seed=2),"wf")
        states=self.db.conn.execute("SELECT COUNT(*) FROM node_states").fetchone()[0]
        self.assertEqual(states,5)  # 4 nodes + one new sampler state
        self.assertEqual(self.db.conn.execute("SELECT COUNT(*) FROM event_nodes").fetchone()[0],8)

    def test_malformed_input_ignored(self):
        self.assertIsNone(self.t.record_event("",graph(),"wf"))
        self.assertIsNone(self.t.record_event("p",None,"wf"))
        e=self.t.record_event("p",{"1":"junk","2":{"inputs":{}},"3":{"class_type":"X","inputs":None}},"wf")
        self.assertEqual([n["node_id"] for n in self.t.get_event(e)["nodes"]],["3"])

    def test_diff_statuses(self):
        a=self.t.record_event("p1",graph(),"wf")
        b=self.t.record_event("p2",graph(seed=5,cfg=4.5,extra=True),"wf")
        d=self.t.diff(a,b)
        status={n["node_id"]:n for n in d["nodes"]}
        self.assertEqual(d["summary"],{"unchanged":3,"changed":1,"added":1,"removed":0})
        self.assertEqual(status["1"]["status"],"unchanged")
        self.assertEqual(status["5"]["status"],"added")
        self.assertEqual(status["2"]["title"],"Sampler")
        self.assertEqual(status["2"]["changes"],[{"param":"cfg","old":7.0,"new":4.5},{"param":"seed","old":1,"new":5}])
        reverse=self.t.diff(b,a)
        self.assertEqual(reverse["summary"]["removed"],1)
        self.assertIsNone(self.t.diff(a,9999))

    def test_rewiring_is_a_change(self):
        a=self.t.record_event("p1",graph(),"wf")
        g=graph(); g["2"]["inputs"]["positive"]=["7",0]
        b=self.t.record_event("p2",g,"wf")
        node=[n for n in self.t.diff(a,b)["nodes"] if n["node_id"]=="2"][0]
        self.assertEqual(node["status"],"changed")
        self.assertEqual(node["changes"],[{"param":"positive","old":["1",0],"new":["7",0]}])

    def test_outputs_link_and_buffer_when_executed_first(self):
        out={"images":[{"filename":"a.png","subfolder":"","type":"output"}]}
        self.assertEqual(self.t.record_outputs("p1","4",out),0)   # event not captured yet
        e=self.t.record_event("p1",graph(),"wf")
        self.assertEqual(self.t.get_event(e)["outputs"],[{"node_id":"4","kind":"images","filename":"a.png","subfolder":"","type":"output"}])
        self.assertEqual(self.t.record_outputs("p1","4",out),0)   # duplicate message
        self.assertEqual(len(self.t.get_event(e)["outputs"]),1)
        self.assertEqual(self.t.record_outputs("p1","4",{"text":["no files"]}),0)
        self.assertEqual(self.t.record_outputs("p1","4",{"gifs":[{"filename":"v.mp4","subfolder":"s","type":"output"}]}),1)

    def test_pending_buffer_is_bounded(self):
        out={"images":[{"filename":"x.png"}]}
        for i in range(tl.MAX_PENDING_PROMPTS+20): self.t.record_outputs(f"never{i}","4",out)
        self.assertLessEqual(len(self.t._pending),tl.MAX_PENDING_PROMPTS)

    def test_node_timeline_collapse_and_changes(self):
        ids=[]
        for i,(seed,text) in enumerate([(1,"cat"),(2,"cat"),(2,"cat"),(3,"dog"),(3,"dog")]):
            ids.append(self.t.record_event(f"p{i}",graph(seed=seed,text=text),"wf"))
            self.t.record_outputs(f"p{i}","4",{"images":[{"filename":f"{i}.png","subfolder":"","type":"output"}]})
        self.t.record_event("other",graph(seed=99),"different-workflow")
        tlne=self.t.node_timeline("wf","2")
        self.assertEqual([e["event_count"] for e in tlne["items"]],[2,2,1])      # newest first: seed3 x2, seed2 x2, seed1
        self.assertEqual(tlne["items"][0]["changes"],[{"param":"seed","old":2,"new":3}])
        self.assertEqual(tlne["items"][2]["changes"],[])
        self.assertEqual([o["filename"] for o in tlne["items"][1]["outputs"]],["1.png","2.png"])
        prompt=self.t.node_timeline("wf","1")
        self.assertEqual([e["event_count"] for e in prompt["items"]],[2,3])
        self.assertEqual(self.t.node_timeline("wf","2",collapse=False)["total"],5)
        self.assertEqual(self.t.node_timeline("wf","2",limit=1)["items"][0]["event_count"],2)
        self.assertEqual(self.t.node_timeline("nowhere","2")["items"],[])

    def test_list_events_filter_and_paging(self):
        for i in range(5): self.t.record_event(f"p{i}",graph(seed=i),"A" if i%2==0 else "B")
        self.assertEqual(len(self.t.list_events()["items"]),5)
        self.assertEqual([e["prompt_id"] for e in self.t.list_events("A")["items"]],["p4","p2","p0"])
        first=self.t.list_events(limit=2)["items"]
        self.assertEqual([e["prompt_id"] for e in first],["p4","p3"])
        self.assertEqual(self.t.list_events(limit=2,before_id=first[-1]["id"])["items"][0]["prompt_id"],"p2")

    def test_middleware_records_event_and_workflow_id(self):
        original=ph.STORE;ph.STORE=self.db
        async def accepted(request):return web.json_response({"prompt_id":"mw1"})
        async def invalid(request):return web.json_response({"error":"bad"},status=400)
        body={"prompt":graph(),"extra_data":{"extra_pnginfo":{"workflow":{"id":"uuid-1","nodes":[]}}}}
        class Req:
            method="POST";path="/api/prompt"
            async def json(self):return body
        try:
            asyncio.run(ph._capture_accepted_prompts(Req(),invalid))
            self.assertEqual(self.t.list_events()["items"],[])
            asyncio.run(ph._capture_accepted_prompts(Req(),accepted))
            ev=self.t.list_events()["items"]
            self.assertEqual((ev[0]["prompt_id"],ev[0]["workflow_id"]),("mw1","uuid-1"))
            self.assertEqual(len(self.t.get_event(ev[0]["id"])["nodes"]),4)
        finally:ph.STORE=original

    def test_workflow_id_variants(self):
        self.assertEqual(ph._workflow_id({}),"")
        self.assertEqual(ph._workflow_id({"extra_data":{"extra_pnginfo":{"workflow":json.dumps({"id":"s"})}}}),"s")
        self.assertEqual(ph._workflow_id({"extra_data":{"workflow":{"id":7}}}),"7")
        self.assertEqual(ph._workflow_id({"extra_data":"junk"}),"")

    def test_executed_hook_passes_through_and_links(self):
        original=ph.STORE;ph.STORE=self.db
        seen=[]
        inst=types.SimpleNamespace(send_sync=lambda event,data,sid=None:seen.append((event,sid)))
        try:
            self.assertTrue(ph._install_output_hook(inst))
            self.assertFalse(ph._install_output_hook(inst))   # no double wrapping
            e=self.t.record_event("h1",graph(),"wf")
            inst.send_sync("executed",{"node":"4","prompt_id":"h1","output":{"images":[{"filename":"z.png","subfolder":"","type":"output"}]}},"client")
            inst.send_sync("executing",{"node":"4"})
            inst.send_sync("executed","not a dict")
            self.assertEqual(seen,[("executed","client"),("executing",None),("executed",None)])
            self.assertEqual(self.t.get_event(e)["outputs"][0]["filename"],"z.png")
        finally:ph.STORE=original

    def test_workflow_summary(self):
        self.assertEqual(self.t.workflow_summary("wf")["nodes"],{})
        self.t.record_event("s1",graph(seed=1),"wf")
        first=self.t.workflow_summary("wf")
        self.assertEqual(first["event_count"],1)
        self.assertIsNone(first["previous_event_id"])
        self.assertFalse(any(n["changed_in_latest"] for n in first["nodes"].values()))
        self.t.record_event("s2",graph(seed=2),"wf")
        self.t.record_event("s3",graph(seed=2,text="dog"),"wf")
        self.t.record_event("other",graph(seed=77),"elsewhere")
        s=self.t.workflow_summary("wf")
        self.assertEqual(s["event_count"],3)
        self.assertEqual(s["nodes"]["2"],{"states":2,"events":3,"changed_in_latest":False})
        self.assertEqual(s["nodes"]["1"],{"states":2,"events":3,"changed_in_latest":True})
        self.assertEqual(s["nodes"]["4"]["states"],1)
        self.assertEqual(self.t.workflow_summary("elsewhere")["event_count"],1)

    def test_run_summary_compares_same_workflow_and_keeps_layout(self):
        a = self.t.record_event("first", graph(seed=1), "wf")
        self.t.record_event("other-workflow", graph(seed=99), "other")
        b = self.t.record_event("second", graph(seed=2), "wf", layout={"2": {"pos": [500, 200]}})
        result = self.t.run_summary(b)
        self.assertEqual(result["comparison"]["a"], a)
        self.assertEqual(result["comparison"]["summary"]["changed"], 1)
        self.assertEqual(result["layout"], {"2": {"pos": [500, 200]}})
        self.assertEqual(self.t.run_summary(a)["comparison"]["a"], None)
        self.assertEqual(self.t.run_summary(a)["layout"], {})
        self.assertIsNone(self.t.run_summary(99999))
        # Reopening an existing database preserves its pre-layout events.
        reopened = tl.Timeline(self.db.conn, self.db.lock)
        self.assertEqual(reopened.run_summary(a)["nodes"], self.t.get_event(a)["nodes"])

    def test_routes(self):
        original=ph.STORE;ph.STORE=self.db
        a=self.t.record_event("r1",graph(),"wf");b=self.t.record_event("r2",graph(seed=9),"wf")
        class Req:
            def __init__(self,**q):self.rel_url=types.SimpleNamespace(query={k:str(v) for k,v in q.items()})
        def call(path,**q):
            resp=asyncio.run(routes.handlers[("GET",path)](Req(**q)))
            return resp.status,json.loads(resp.body)
        try:
            self.assertEqual(call("/prompt_history/timeline/events",workflow_id="wf")[1]["items"][0]["prompt_id"],"r2")
            self.assertEqual(call("/prompt_history/timeline/event",id=a)[0],200)
            self.assertEqual(call("/prompt_history/timeline/event",id=999)[0],404)
            self.assertEqual(call("/prompt_history/timeline/event",id="x")[0],400)
            self.assertEqual(call("/prompt_history/timeline/diff",a=a,b=b)[1]["summary"]["changed"],1)
            self.assertEqual(call("/prompt_history/timeline/diff",a=a,b=999)[0],404)
            self.assertEqual(call("/prompt_history/timeline/node",workflow_id="wf",node_id="2")[1]["total"],2)
            self.assertEqual(call("/prompt_history/timeline/node",workflow_id="wf")[0],400)
            self.assertEqual(call("/prompt_history/timeline/workflow",workflow_id="wf")[1]["event_count"],2)
        finally:ph.STORE=original

if __name__=="__main__": unittest.main()
