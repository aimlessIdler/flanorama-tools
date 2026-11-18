"""Prompt History: a small, persistent prompt editor for ComfyUI.

Auto-capture is performed after /prompt has actually been accepted, including
prompts submitted via the API. The node emits ordinary STRING to CLIPTextEncode.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .timeline import Timeline

LOGGER = logging.getLogger("comfyui.prompt_history")
MAX_TEXT_CHARS = 200_000


def _normalize_prompt_text(text):
    if not isinstance(text, str):
        raise ValueError("Prompt must be text")
    # Normalize line endings and strip edge whitespace so visually identical
    # prompts do not create separate history entries. Internal whitespace is
    # preserved exactly.
    value = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value or len(value) > MAX_TEXT_CHARS:
        raise ValueError("Prompt must contain 1 to 200,000 characters")
    return value


def _data_location():
    try:
        import folder_paths
        base = Path(folder_paths.get_user_directory())
    except (ImportError, AttributeError, TypeError):
        base = Path(__file__).resolve().parent / "data"
    return base / "prompt_history" / "history.sqlite3"


class HistoryStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30)
        self.conn.row_factory = sqlite3.Row
        with self.lock, self.conn:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("""CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL UNIQUE,
                created_ms INTEGER NOT NULL,
                updated_ms INTEGER NOT NULL,
                queue_count INTEGER NOT NULL DEFAULT 0,
                manual_count INTEGER NOT NULL DEFAULT 0,
                run_count INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                last_source TEXT NOT NULL DEFAULT 'manual'
            )""")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_recent ON entries(updated_ms DESC, id DESC)")
            self.conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            self.conn.execute("INSERT OR IGNORE INTO settings (key,value) VALUES ('max_entries','0')")
        # Per-queue event log (node states, outputs) lives in the same database.
        self.timeline = Timeline(self.conn, self.lock)

    def max_entries(self):
        with self.lock:
            return int(self.conn.execute("SELECT value FROM settings WHERE key='max_entries'").fetchone()[0])

    def _prune(self):
        max_count = self.max_entries()
        if max_count == 0:
            return
        excess = self.conn.execute("SELECT MAX(COUNT(*)-?,0) FROM entries", (max_count,)).fetchone()[0]
        if excess > 0:
            # Pinned entries are never automatically deleted; cap can be exceeded if all pinned.
            self.conn.execute("""DELETE FROM entries WHERE id IN (
                SELECT id FROM entries WHERE pinned=0 ORDER BY updated_ms ASC,id ASC LIMIT ?
            )""", (excess,))

    def save(self, text, source="manual"):
        value = _normalize_prompt_text(text)
        if source not in ("manual", "queued", "executed"):
            raise ValueError("Invalid source")
        column = {"manual": "manual_count", "queued": "queue_count", "executed": "run_count"}[source]
        now = int(time.time() * 1000)
        with self.lock, self.conn:
            row = self.conn.execute("SELECT id FROM entries WHERE text=?", (value,)).fetchone()
            if row:
                self.conn.execute(f"UPDATE entries SET updated_ms=?,last_source=?,{column}={column}+1 WHERE id=?", (now, source, row[0]))
                key = row[0]
            else:
                self.conn.execute(f"INSERT INTO entries (text,created_ms,updated_ms,{column},last_source) VALUES (?,?,?,?,?)", (value,now,now,1,source))
                key = self.conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            self._prune()
            return key

    def ensure_queued(self, text, window_ms=5000):
        """Browser fallback for a successful queue, idempotent with server capture.

        We only suppress an additional queue count when the identical prompt was
        just recorded at the server. This endpoint must not save failed queues.
        """
        value = _normalize_prompt_text(text)
        now = int(time.time()*1000)
        with self.lock:
            row = self.conn.execute(
                "SELECT id, updated_ms, queue_count FROM entries WHERE text=?", (value,)
            ).fetchone()
            if row and row["queue_count"] > 0 and now-row["updated_ms"] < window_ms:
                return row["id"], False
            return self.save(value, "queued"), True

    def list(self, q="", offset=0, limit=100, pinned_only=False):
        limit = max(1, min(250, int(limit)))
        offset = max(0, int(offset))
        where = []
        args = []
        if q:
            where.append("text LIKE ? ESCAPE '\\'")
            escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args.append(f"%{escaped}%")
        if pinned_only:
            where.append("pinned=1")
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self.lock:
            count = self.conn.execute("SELECT COUNT(*) FROM entries" + clause, args).fetchone()[0]
            rows = self.conn.execute(
                "SELECT * FROM entries" + clause + " ORDER BY updated_ms DESC,id DESC LIMIT ? OFFSET ?",
                [*args,limit,offset],
            ).fetchall()
            return {"items": [dict(row) for row in rows], "total": count, "offset": offset, "max_entries": self.max_entries()}

    def delete(self, entry_id):
        with self.lock, self.conn:
            return self.conn.execute("DELETE FROM entries WHERE id=?", (int(entry_id),)).rowcount > 0

    def pin(self, entry_id, value):
        with self.lock, self.conn:
            return self.conn.execute("UPDATE entries SET pinned=? WHERE id=?", (int(bool(value)),int(entry_id))).rowcount > 0

    def configure(self, max_entries):
        value = int(max_entries)
        if value < 0 or value > 10_000_000:
            raise ValueError("History limit must be 0 (unlimited) or 1–10,000,000")
        with self.lock, self.conn:
            self.conn.execute("UPDATE settings SET value=? WHERE key='max_entries'", (str(value),))
            self._prune()
        return value

    def clear(self, include_pinned=False):
        with self.lock, self.conn:
            result = self.conn.execute("DELETE FROM entries" + ("" if include_pinned else " WHERE pinned=0"))
            return result.rowcount

    def export(self):
        with self.lock:
            rows = self.conn.execute("SELECT * FROM entries ORDER BY created_ms ASC,id ASC").fetchall()
            return {"format": "ComfyUI-Prompt-History/1", "max_entries": self.max_entries(), "items": [dict(r) for r in rows]}

    def import_items(self, entries):
        if not isinstance(entries, list) or len(entries)>100_000:
            raise ValueError("Import must be an array of at most 100,000 entries")
        imported=0
        for row in entries:
            value = row if isinstance(row,str) else row.get("text") if isinstance(row,dict) else None
            try:
                value = _normalize_prompt_text(value)
            except ValueError:
                continue
            try:
                key = self.save(value, "manual")
                if isinstance(row,dict) and row.get("pinned"):
                    self.pin(key,True)
                imported+=1
            except (ValueError, sqlite3.Error):
                continue
        return imported


STORE = HistoryStore(_data_location())


class PromptHistoryText:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "prompt": ("STRING", {"multiline": True, "dynamicPrompts": False, "tooltip": "Positive prompt text. Stored in history when this workflow is queued."}),
        }, "optional": {
            "external_prompt": ("STRING", {"forceInput": True, "tooltip": "Optional external string. Overrides the editor during execution."}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("PROMPT",)
    FUNCTION = "forward"
    CATEGORY = "text/prompt"
    DESCRIPTION = "A standard STRING prompt with unlimited persistent history, automatic queue capture and manual Save. Connect PROMPT to CLIP Text Encode's text input."

    def forward(self, prompt, external_prompt=None):
        text = external_prompt if external_prompt is not None else prompt
        # Linked inputs are resolved only during execution; the queue request contains
        # a graph link rather than their text. Capture here in that case.
        if external_prompt is not None:
            try:
                STORE.save(text,"executed")
                _notify_updated()
            except ValueError:
                pass
        return (text,)


def _get_prompt_texts(submitted):
    """Read live API inputs first, then fallback to metadata-only canvas nodes.

    ComfyUI prunes unconnected nodes from the executable prompt graph. The
    workflow metadata often still contains those nodes, so a Prompt History
    editor can function as an archive even when it is not on the execution path.
    Never record its stale editor draft when an external_prompt wire is present.
    """
    graph = submitted.get("prompt") or {}
    if not isinstance(graph, dict):
        return []
    captured = []
    seen_ids = set()
    excluded_ids = set()
    for node_id,node in graph.items():
        if not isinstance(node,dict) or node.get("class_type") != "PromptHistoryText":
            continue
        inputs=node.get("inputs") or {}
        if not isinstance(inputs,dict):
            continue
        seen_ids.add(str(node_id))
        ext=inputs.get("external_prompt")
        if isinstance(ext,list):
            excluded_ids.add(str(node_id))
            continue
        text = ext if isinstance(ext,str) else inputs.get("prompt")
        if isinstance(text,str) and text.strip():
            captured.append(text)

    # Read the visual graph when ComfyUI excluded a disconnected history node.
    extra=submitted.get("extra_data") or {}
    if not isinstance(extra,dict):
        extra={}
    metadata=extra.get("extra_pnginfo") or {}
    if not isinstance(metadata,dict):
        metadata={}
    workflow=metadata.get("workflow") or extra.get("workflow") or {}
    if isinstance(workflow,str):
        try:
            workflow=json.loads(workflow)
        except (ValueError,TypeError):
            workflow={}
    if isinstance(workflow,dict):
        nodes=workflow.get("nodes") or []
        if isinstance(nodes,list):
            for node in nodes:
                if not isinstance(node,dict) or node.get("type")!="PromptHistoryText":
                    continue
                node_id=str(node.get("id"))
                if node_id in seen_ids or node_id in excluded_ids:
                    continue
                inputs=node.get("inputs") or []
                if isinstance(inputs,list) and any(isinstance(i,dict) and i.get("name")=="external_prompt" and i.get("link") is not None for i in inputs):
                    continue
                named=node.get("widgets_values_named") or {}
                text = named.get("prompt") if isinstance(named,dict) else None
                if not isinstance(text,str):
                    values=node.get("widgets_values") or []
                    text=values[0] if isinstance(values,list) and values else None
                if isinstance(text,str) and text.strip():
                    captured.append(text)
    return list(dict.fromkeys(captured))


def _notify_updated():
    try:
        PromptServer.instance.send_sync("prompt_history.updated", {})
    except (AttributeError, RuntimeError):
        pass


def _notify_timeline(prompt_id):
    try:
        PromptServer.instance.send_sync("prompt_history.timeline", {"prompt_id": prompt_id})
    except (AttributeError, RuntimeError):
        pass


def _workflow_id(submitted):
    """Stable id of the visual workflow that produced a submission, or "" if unknown."""
    extra = submitted.get("extra_data") or {}
    if not isinstance(extra, dict):
        return ""
    metadata = extra.get("extra_pnginfo") or {}
    workflow = (metadata.get("workflow") if isinstance(metadata, dict) else None) or extra.get("workflow") or {}
    if isinstance(workflow, str):
        try:
            workflow = json.loads(workflow)
        except (ValueError, TypeError):
            workflow = {}
    wid = workflow.get("id") if isinstance(workflow, dict) else None
    return str(wid) if wid else ""


def _workflow_layout(submitted):
    extra = submitted.get("extra_data") or {}
    if not isinstance(extra, dict):
        return {}
    info = extra.get("extra_pnginfo") or {}
    workflow = (info.get("workflow") if isinstance(info, dict) else None) or extra.get("workflow") or {}
    if isinstance(workflow, str):
        try:
            workflow = json.loads(workflow)
        except ValueError:
            return {}
    if not isinstance(workflow, dict):
        return {}
    result = {}
    for node in workflow.get("nodes", []):
        if not isinstance(node, dict):
            continue
        pos = node.get("pos")
        if isinstance(pos, list) and len(pos) >= 2 and all(isinstance(v, (int, float)) for v in pos[:2]):
            result[str(node.get("id"))] = {"pos": pos[:2]}
    return result


def _on_executed(data):
    """Link an `executed` message's file outputs to their queue event."""
    if not isinstance(data, dict):
        return
    node_id = data.get("node") if data.get("node") is not None else data.get("display_node")
    STORE.timeline.record_outputs(data.get("prompt_id"), node_id, data.get("output"))


def _install_output_hook(instance):
    """Observe `executed` messages by wrapping send_sync. Messages pass through unchanged."""
    original = getattr(instance, "send_sync", None)
    if original is None or getattr(original, "_prompt_history_hook", False):
        return False

    def send_sync(event, data, *args, **kwargs):
        if event == "executed":
            try:
                _on_executed(data)
            except Exception:
                LOGGER.exception("Could not link executed output (generation unaffected)")
        return original(event, data, *args, **kwargs)

    send_sync._prompt_history_hook = True
    instance.send_sync = send_sync
    return True


@web.middleware
async def _capture_accepted_prompts(request, handler):
    # Follow the actual ComfyUI acceptance response (prompt_id), and support
    # both /prompt and /api/prompt paths as well as reverse-proxy prefixes.
    path=request.path.rstrip("/")
    if request.method != "POST" or path.rsplit("/",1)[-1] != "prompt":
        return await handler(request)
    try:
        submitted=await request.json()
    except Exception:
        submitted=None
    response=await handler(request)
    if response.status != 200 or not isinstance(submitted,dict):
        return response
    try:
        prompt_id=json.loads(response.body or b"{}").get("prompt_id")
    except Exception:
        return response
    if not prompt_id:
        return response
    try:
        recorded=False
        for value in _get_prompt_texts(submitted):
            STORE.save(value, "queued")
            recorded=True
        if recorded:
            _notify_updated()
    except Exception:
        LOGGER.exception("Could not record queued prompt (generation unaffected)")
    try:
        if STORE.timeline.record_event(prompt_id, submitted.get("prompt"), _workflow_id(submitted),
                                       layout=_workflow_layout(submitted)) is not None:
            _notify_timeline(prompt_id)
    except Exception:
        LOGGER.exception("Could not record queue event (generation unaffected)")
    return response


def _as_json(data, status=200):
    return web.json_response(data,status=status)


@PromptServer.instance.routes.get("/prompt_history/timeline/run")
async def _timeline_run(request):
    try:
        result = STORE.timeline.run_summary(int(request.rel_url.query["id"]))
        return _as_json(result if result else {"error": "Run not found"}, 200 if result else 404)
    except (KeyError, ValueError, TypeError):
        return _as_json({"error": "A valid run id is required"}, 400)


@PromptServer.instance.routes.get("/prompt_history/list")
async def _list(request):
    try:
        params=request.rel_url.query
        return _as_json(STORE.list(params.get("q",""),params.get("offset",0),params.get("limit",100),params.get("pinned","0")=="1"))
    except (ValueError, TypeError) as error:
        return _as_json({"error":str(error)},400)


async def _body(request):
    data=await request.json()
    if not isinstance(data,dict):
        raise ValueError("Expected JSON object")
    return data


@PromptServer.instance.routes.post("/prompt_history/save")
async def _manual_save(request):
    try:
        data=await _body(request)
        key=STORE.save(data.get("text"),"manual")
        return _as_json({"id":key,"total":STORE.list(limit=1)["total"]})
    except (ValueError,TypeError) as error:
        return _as_json({"error":str(error)},400)


@PromptServer.instance.routes.post("/prompt_history/ensure_queued")
async def _ensure_queued(request):
    # Called only from the frontend's successful promptQueued event.
    try:
        data=await _body(request)
        key, added=STORE.ensure_queued(data.get("text"))
        if added:
            _notify_updated()
        return _as_json({"id":key,"added":added})
    except (ValueError,TypeError) as error:
        return _as_json({"error":str(error)},400)


@PromptServer.instance.routes.post("/prompt_history/delete")
async def _delete(request):
    try:
        data=await _body(request)
        return _as_json({"deleted":STORE.delete(data["id"])})
    except (ValueError,TypeError,KeyError) as error:
        return _as_json({"error":str(error)},400)


@PromptServer.instance.routes.post("/prompt_history/pin")
async def _pin(request):
    try:
        data=await _body(request)
        return _as_json({"updated":STORE.pin(data["id"],data["pinned"])})
    except (ValueError,TypeError,KeyError) as error:
        return _as_json({"error":str(error)},400)


@PromptServer.instance.routes.post("/prompt_history/settings")
async def _settings(request):
    try:
        data=await _body(request)
        return _as_json({"max_entries":STORE.configure(data["max_entries"])})
    except (ValueError,TypeError,KeyError) as error:
        return _as_json({"error":str(error)},400)


@PromptServer.instance.routes.post("/prompt_history/clear")
async def _clear(request):
    try:
        data=await _body(request)
        return _as_json({"deleted":STORE.clear(bool(data.get("include_pinned",False)))})
    except (ValueError,TypeError) as error:
        return _as_json({"error":str(error)},400)


@PromptServer.instance.routes.get("/prompt_history/export")
async def _export(request):
    return web.json_response(STORE.export(),headers={"Content-Disposition": "attachment; filename=prompt-history.json"})


@PromptServer.instance.routes.post("/prompt_history/import")
async def _import(request):
    try:
        data=await _body(request)
        return _as_json({"imported":STORE.import_items(data.get("items"))})
    except (ValueError,TypeError) as error:
        return _as_json({"error":str(error)},400)


def _int_param(params, name, default=None):
    value = params.get(name)
    return default if value in (None, "") else int(value)


@PromptServer.instance.routes.get("/prompt_history/timeline/events")
async def _timeline_events(request):
    try:
        params = request.rel_url.query
        return _as_json(STORE.timeline.list_events(params.get("workflow_id"), _int_param(params, "limit", 50), _int_param(params, "before_id")))
    except (ValueError, TypeError) as error:
        return _as_json({"error": str(error)}, 400)


@PromptServer.instance.routes.get("/prompt_history/timeline/event")
async def _timeline_event(request):
    try:
        event = STORE.timeline.get_event(_int_param(request.rel_url.query, "id", -1))
        return _as_json(event) if event else _as_json({"error": "No such event"}, 404)
    except (ValueError, TypeError) as error:
        return _as_json({"error": str(error)}, 400)


@PromptServer.instance.routes.get("/prompt_history/timeline/diff")
async def _timeline_diff(request):
    try:
        params = request.rel_url.query
        result = STORE.timeline.diff(_int_param(params, "a", -1), _int_param(params, "b", -1))
        return _as_json(result) if result else _as_json({"error": "No such event"}, 404)
    except (ValueError, TypeError) as error:
        return _as_json({"error": str(error)}, 400)


@PromptServer.instance.routes.get("/prompt_history/timeline/workflow")
async def _timeline_workflow(request):
    return _as_json(STORE.timeline.workflow_summary(request.rel_url.query.get("workflow_id", "")))


@PromptServer.instance.routes.get("/prompt_history/timeline/node")
async def _timeline_node(request):
    try:
        params = request.rel_url.query
        if not params.get("node_id"):
            return _as_json({"error": "node_id is required"}, 400)
        return _as_json(STORE.timeline.node_timeline(
            params.get("workflow_id", ""), params["node_id"], _int_param(params, "limit", 100), params.get("collapse", "1") != "0"))
    except (ValueError, TypeError) as error:
        return _as_json({"error": str(error)}, 400)


try:
    _install_output_hook(PromptServer.instance)
except Exception:
    LOGGER.exception("Failed to install executed-output hook")

try:
    PromptServer.instance.app.middlewares.append(_capture_accepted_prompts)
except RuntimeError:
    LOGGER.exception("Failed to register prompt queue capture middleware")
