"""Standalone tests; ComfyUI itself is not required."""
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
spec=importlib.util.spec_from_file_location("_prompt_history",ROOT/"prompt_history.py", submodule_search_locations=[str(ROOT)])
ph=importlib.util.module_from_spec(spec)
sys.modules["_prompt_history"]=ph
spec.loader.exec_module(ph)


def tearDownModule():
    ph.STORE.conn.close()
    _user_dir.cleanup()


class TestHistory(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.db=ph.HistoryStore(Path(self.tmp.name)/"history.sqlite3")
    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()
    def test_manual_dedupe(self):
        first=self.db.save(" first prompt ","manual")
        second=self.db.save("first prompt","queued")
        self.assertEqual(first,second)
        item=self.db.list()["items"][0]
        self.assertEqual(item["manual_count"],1)
        self.assertEqual(item["queue_count"],1)
        self.assertEqual(self.db.list()["total"],1)
    def test_line_ending_normalization_dedupes(self):
        first=self.db.save("line1\r\nline2\n","manual")
        second=self.db.save("line1\nline2","queued")
        self.assertEqual(first, second)
        item=self.db.list()["items"][0]
        self.assertEqual(item["text"], "line1\nline2")
        self.assertEqual(item["manual_count"],1)
        self.assertEqual(item["queue_count"],1)

    def test_unlimited_and_limit(self):
        for i in range(120): self.db.save(f"prompt {i}","queued")
        self.assertEqual(self.db.list()["total"],120)
        self.db.configure(100)
        self.assertEqual(self.db.list()["total"],100)
        self.assertEqual(self.db.list(offset=99,limit=1)["items"][0]["text"],"prompt 20")
    def test_keep_pinned(self):
        self.db.save("pinned","manual")
        first=self.db.list()["items"][0]
        self.db.pin(first["id"],True)
        self.db.configure(2)
        for i in range(10): self.db.save(f"next {i}","queued")
        self.assertEqual(self.db.list()["total"],2)
        self.assertIn("pinned",[r["text"] for r in self.db.list()["items"]])
    def test_search_export_import(self):
        self.db.save("sunset","queued")
        self.db.save("brunette in office","manual")
        self.assertEqual(self.db.list(q="office")["total"],1)
        e=self.db.export()
        other=ph.HistoryStore(Path(self.tmp.name)/"imported.sqlite3")
        try:
            self.assertEqual(other.import_items(e["items"]),2)
            self.assertEqual(other.list()["total"],2)
        finally: other.conn.close()
    def test_node_outputs(self):
        n=ph.PromptHistoryText()
        self.assertEqual(n.forward("text"),("text",))
        # Temporarily swap global store for linked input test
        original=ph.STORE;ph.STORE=self.db
        try:
            self.assertEqual(n.forward("stale",external_prompt="resolved"),("resolved",))
            self.assertEqual(self.db.list()["items"][0]["text"],"resolved")
        finally:ph.STORE=original
    def test_successful_queue_only(self):
        original=ph.STORE;ph.STORE=self.db
        async def accepted(request):
            return web.json_response({"prompt_id":"aaa"})
        async def invalid(request):
            return web.json_response({"error":"invalid"},status=400)
        class FakeRequest:
            method="POST";path="/prompt"
            async def json(self):return {"prompt":{
                "42":{"class_type":"PromptHistoryText","inputs":{"prompt":"Test queued string"}},
            }}
        try:
            asyncio.run(ph._capture_accepted_prompts(FakeRequest(),invalid))
            self.assertEqual(self.db.list()["total"],0)
            asyncio.run(ph._capture_accepted_prompts(FakeRequest(),accepted))
            self.assertEqual(self.db.list()["total"],1)
            self.assertEqual(self.db.list()["items"][0]["queue_count"],1)
        finally:ph.STORE=original
    def test_api_prefix_queued(self):
        original=ph.STORE;ph.STORE=self.db
        async def accepted(request):return web.json_response({"prompt_id":"queued"})
        class Request:
            method="POST";path="/api/prompt"
            async def json(self):return {"prompt":{"42":{"class_type":"PromptHistoryText","inputs":{"prompt":"API routed"}}}}
        try:
            asyncio.run(ph._capture_accepted_prompts(Request(),accepted))
            self.assertEqual(self.db.list()["items"][0]["text"],"API routed")
        finally:ph.STORE=original

    def test_visual_workflow_orphan_node(self):
        data={"prompt":{"20":{"class_type":"CLIPTextEncode","inputs":{"text":"x"}}},
              "extra_data":{"extra_pnginfo":{"workflow":{"nodes":[
                  {"id":100,"type":"PromptHistoryText","inputs":[],"widgets_values":["Orphan draft"]}
              ]}}}}
        self.assertEqual(ph._get_prompt_texts(data),["Orphan draft"])

    def test_visual_workflow_linked_external_does_not_capture_draft(self):
        data={"prompt":{},"extra_data":{"extra_pnginfo":{"workflow":{"nodes":[
            {"id":100,"type":"PromptHistoryText","inputs":[{"name":"external_prompt","link":1}],
             "widgets_values":["Stale editor draft"]}
        ]}}}}
        self.assertEqual(ph._get_prompt_texts(data),[])

    def test_ensure_after_server_capture_avoids_double_count(self):
        self.db.save("prompt","queued")
        entry,added=self.db.ensure_queued("prompt")
        self.assertFalse(added)
        self.assertEqual(self.db.list()["items"][0]["queue_count"],1)
        entry,added=self.db.ensure_queued("not seen yet")
        self.assertTrue(added)
        self.assertEqual(self.db.list()["total"],2)

    def test_linked_text_skips_stale(self):
        original=ph.STORE;ph.STORE=self.db
        async def accepted(request):return web.json_response({"prompt_id":"bbb"})
        class FakeRequest:
            method="POST";path="/prompt"
            async def json(self):return {"prompt":{
                "42":{"class_type":"PromptHistoryText","inputs":{"prompt":"stale text","external_prompt":["21",0]}},
            }}
        try:
            asyncio.run(ph._capture_accepted_prompts(FakeRequest(),accepted))
            self.assertEqual(self.db.list()["total"],0)
        finally:ph.STORE=original

if __name__=="__main__": unittest.main()
