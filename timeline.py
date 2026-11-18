"""Event log for Prompt History: per-queue node states and linked outputs.

Every accepted queue submission becomes one ``queue_events`` row. Each node in
the submitted API graph is recorded as a content-addressed state (hash of
class_type + inputs), so an unchanged node costs one small ``event_nodes`` row
and a changed node adds one ``node_states`` row. Outputs reported by ComfyUI's
``executed`` messages are linked to the event and the node that produced them.
"""
from __future__ import annotations

import hashlib
import json
import threading

MAX_PENDING_PROMPTS = 256
OUTPUT_STRIP_CAP = 24


def compute_state_hash(class_type, inputs):
    payload = json.dumps({"c": class_type, "i": inputs}, sort_keys=True,
                         separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def param_deltas(old, new):
    """Per-parameter differences between two input dicts.

    A key is omitted from a delta when the parameter is absent on that side.
    """
    old = old or {}
    new = new or {}
    deltas = []
    for key in sorted(set(old) | set(new)):
        if key in old and key in new:
            if old[key] != new[key]:
                deltas.append({"param": key, "old": old[key], "new": new[key]})
        elif key in old:
            deltas.append({"param": key, "old": old[key]})
        else:
            deltas.append({"param": key, "new": new[key]})
    return deltas


def _file_items(output):
    """Yield (kind, filename, subfolder, type) for file references in an executed output."""
    if not isinstance(output, dict):
        return
    for kind, value in output.items():
        if not isinstance(value, list):
            continue
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("filename"), str):
                yield (str(kind), item["filename"], str(item.get("subfolder") or ""), str(item.get("type") or ""))


class Timeline:
    def __init__(self, conn, lock=None):
        self.conn = conn
        self.lock = lock or threading.RLock()
        self._pending = {}  # prompt_id -> [(node_id, output)] for outputs that beat the queue capture
        with self.lock, self.conn:
            self.conn.execute("""CREATE TABLE IF NOT EXISTS queue_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_id TEXT NOT NULL UNIQUE,
                ts_ms INTEGER NOT NULL,
                workflow_id TEXT NOT NULL DEFAULT ''
            )""")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_events_workflow ON queue_events(workflow_id, id)")
            self.conn.execute("""CREATE TABLE IF NOT EXISTS node_states (
                hash TEXT PRIMARY KEY,
                class_type TEXT NOT NULL,
                inputs_json TEXT NOT NULL
            )""")
            self.conn.execute("""CREATE TABLE IF NOT EXISTS event_nodes (
                event_id INTEGER NOT NULL REFERENCES queue_events(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                state_hash TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (event_id, node_id)
            )""")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_event_nodes_node ON event_nodes(node_id, event_id)")
            self.conn.execute("""CREATE TABLE IF NOT EXISTS event_outputs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL REFERENCES queue_events(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                filename TEXT NOT NULL,
                subfolder TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL DEFAULT '',
                UNIQUE (event_id, node_id, kind, filename, subfolder, type)
            )""")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_event_outputs_event ON event_outputs(event_id)")
            self.conn.execute("""CREATE TABLE IF NOT EXISTS event_layouts (
                event_id INTEGER PRIMARY KEY REFERENCES queue_events(id) ON DELETE CASCADE,
                layout_json TEXT NOT NULL
            )""")

    # ---- capture -----------------------------------------------------------

    def record_event(self, prompt_id, graph, workflow_id="", now_ms=None, layout=None):
        """Record one accepted queue submission. Idempotent per prompt_id."""
        import time
        if not isinstance(prompt_id, str) or not prompt_id or not isinstance(graph, dict):
            return None
        now = int(now_ms if now_ms is not None else time.time() * 1000)
        with self.lock, self.conn:
            existing = self.conn.execute("SELECT id FROM queue_events WHERE prompt_id=?", (prompt_id,)).fetchone()
            if existing:
                return existing[0]
            event_id = self.conn.execute(
                "INSERT INTO queue_events (prompt_id, ts_ms, workflow_id) VALUES (?,?,?)",
                (prompt_id, now, str(workflow_id or ""))).lastrowid
            if isinstance(layout, dict):
                self.conn.execute("INSERT INTO event_layouts VALUES (?,?)",
                                  (event_id, json.dumps(layout, ensure_ascii=False)))
            for node_id, node in graph.items():
                if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
                    continue
                inputs = node.get("inputs")
                inputs = inputs if isinstance(inputs, dict) else {}
                class_type = node["class_type"]
                digest = compute_state_hash(class_type, inputs)
                meta = node.get("_meta")
                title = meta.get("title") if isinstance(meta, dict) else ""
                self.conn.execute(
                    "INSERT OR IGNORE INTO node_states (hash, class_type, inputs_json) VALUES (?,?,?)",
                    (digest, class_type, json.dumps(inputs, sort_keys=True, ensure_ascii=False, default=str)))
                self.conn.execute(
                    "INSERT OR REPLACE INTO event_nodes (event_id, node_id, state_hash, title) VALUES (?,?,?,?)",
                    (event_id, str(node_id), digest, title if isinstance(title, str) else ""))
            pending = self._pending.pop(prompt_id, [])
            for node_id, output in pending:
                self._insert_outputs(event_id, node_id, output)
        return event_id

    def _insert_outputs(self, event_id, node_id, output):
        added = 0
        for kind, filename, subfolder, ftype in _file_items(output):
            added += self.conn.execute(
                "INSERT OR IGNORE INTO event_outputs (event_id, node_id, kind, filename, subfolder, type) VALUES (?,?,?,?,?,?)",
                (event_id, str(node_id), kind, filename, subfolder, ftype)).rowcount
        return added

    def record_outputs(self, prompt_id, node_id, output):
        """Link an ``executed`` output to its event.

        ComfyUI can start executing before the queue middleware has recorded
        the event, so unmatched outputs wait in a small bounded buffer.
        """
        if not isinstance(prompt_id, str) or node_id is None or not any(True for _ in _file_items(output)):
            return 0
        with self.lock, self.conn:
            row = self.conn.execute("SELECT id FROM queue_events WHERE prompt_id=?", (prompt_id,)).fetchone()
            if row:
                return self._insert_outputs(row[0], node_id, output)
            if prompt_id not in self._pending and len(self._pending) >= MAX_PENDING_PROMPTS:
                self._pending.pop(next(iter(self._pending)))
            self._pending.setdefault(prompt_id, []).append((str(node_id), output))
            return 0

    # ---- reads -------------------------------------------------------------

    def _outputs_for(self, event_ids):
        if not event_ids:
            return {}
        marks = ",".join("?" * len(event_ids))
        rows = self.conn.execute(
            f"SELECT event_id, node_id, kind, filename, subfolder, type FROM event_outputs WHERE event_id IN ({marks}) ORDER BY id",
            list(event_ids)).fetchall()
        grouped = {}
        for r in rows:
            grouped.setdefault(r["event_id"], []).append(
                {"node_id": r["node_id"], "kind": r["kind"], "filename": r["filename"], "subfolder": r["subfolder"], "type": r["type"]})
        return grouped

    def list_events(self, workflow_id=None, limit=50, before_id=None):
        limit = max(1, min(500, int(limit)))
        where, args = [], []
        if workflow_id is not None:
            where.append("workflow_id=?")
            args.append(str(workflow_id))
        if before_id is not None:
            where.append("id<?")
            args.append(int(before_id))
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self.lock:
            rows = self.conn.execute(
                "SELECT e.id, e.prompt_id, e.ts_ms, e.workflow_id, "
                "(SELECT COUNT(*) FROM event_outputs o WHERE o.event_id=e.id) AS output_count "
                "FROM queue_events e" + clause + " ORDER BY e.id DESC LIMIT ?", [*args, limit]).fetchall()
            return {"items": [dict(r) for r in rows]}

    def _event_nodes(self, event_id):
        rows = self.conn.execute(
            "SELECT n.node_id, n.state_hash, n.title, s.class_type, s.inputs_json "
            "FROM event_nodes n JOIN node_states s ON s.hash=n.state_hash WHERE n.event_id=?", (int(event_id),)).fetchall()
        return {r["node_id"]: {"node_id": r["node_id"], "state_hash": r["state_hash"], "title": r["title"],
                               "class_type": r["class_type"], "inputs": json.loads(r["inputs_json"])} for r in rows}

    def get_event(self, event_id):
        with self.lock:
            row = self.conn.execute("SELECT id, prompt_id, ts_ms, workflow_id FROM queue_events WHERE id=?", (int(event_id),)).fetchone()
            if not row:
                return None
            nodes = self._event_nodes(row["id"])
            return {**dict(row), "nodes": list(nodes.values()), "outputs": self._outputs_for([row["id"]]).get(row["id"], [])}

    def run_summary(self, event_id):
        """Compare a queue submission to its preceding run of the same workflow."""
        with self.lock:
            event = self.get_event(event_id)
            if event is None:
                return None
            previous = self.conn.execute(
                "SELECT id FROM queue_events WHERE workflow_id=? AND id<? ORDER BY id DESC LIMIT 1",
                (event["workflow_id"], event["id"])).fetchone()
            layout = self.conn.execute("SELECT layout_json FROM event_layouts WHERE event_id=?",
                                       (event["id"],)).fetchone()
            comparison = self.diff(previous[0], event["id"]) if previous else {
                "a": None, "b": event["id"],
                "summary": {"unchanged": 0, "changed": 0, "added": len(event["nodes"]), "removed": 0},
                "nodes": [{**node, "status": "added", "changes": []} for node in event["nodes"]],
            }
            return {**event, "comparison": comparison, "layout": json.loads(layout[0]) if layout else {}}

    def diff(self, a_id, b_id):
        """Compare two events node by node: unchanged / changed / added / removed (relative to a)."""
        with self.lock:
            a_exists = self.conn.execute("SELECT 1 FROM queue_events WHERE id=?", (int(a_id),)).fetchone()
            b_exists = self.conn.execute("SELECT 1 FROM queue_events WHERE id=?", (int(b_id),)).fetchone()
            if not a_exists or not b_exists:
                return None
            a_nodes, b_nodes = self._event_nodes(a_id), self._event_nodes(b_id)
            outputs = self._outputs_for([int(a_id), int(b_id)])
        result, summary = [], {"unchanged": 0, "changed": 0, "added": 0, "removed": 0}
        for node_id in sorted(set(a_nodes) | set(b_nodes), key=lambda s: (len(s), s)):
            a, b = a_nodes.get(node_id), b_nodes.get(node_id)
            if a and b:
                if a["state_hash"] == b["state_hash"]:
                    status, changes = "unchanged", []
                else:
                    status = "changed"
                    changes = param_deltas(a["inputs"], b["inputs"])
                    if a["class_type"] != b["class_type"]:
                        changes.insert(0, {"param": "class_type", "old": a["class_type"], "new": b["class_type"]})
            else:
                status, changes = ("added", []) if b else ("removed", [])
            summary[status] += 1
            ref = b or a
            result.append({"node_id": node_id, "status": status, "class_type": ref["class_type"],
                           "title": ref["title"], "changes": changes})
        return {"a": int(a_id), "b": int(b_id), "summary": summary, "nodes": result,
                "outputs": {"a": outputs.get(int(a_id), []), "b": outputs.get(int(b_id), [])}}

    def workflow_summary(self, workflow_id):
        """Per-node counts for one workflow, for canvas badges.

        ``states`` is the number of distinct states a node has been queued with;
        ``changed_in_latest`` marks nodes whose state differs from the previous event.
        """
        wid = str(workflow_id or "")
        with self.lock:
            ids = [r[0] for r in self.conn.execute(
                "SELECT id FROM queue_events WHERE workflow_id=? ORDER BY id DESC LIMIT 2", (wid,))]
            if not ids:
                return {"workflow_id": wid, "event_count": 0, "latest_event_id": None, "previous_event_id": None, "nodes": {}}
            event_count = self.conn.execute("SELECT COUNT(*) FROM queue_events WHERE workflow_id=?", (wid,)).fetchone()[0]
            latest = {r["node_id"]: r["state_hash"] for r in self.conn.execute(
                "SELECT node_id, state_hash FROM event_nodes WHERE event_id=?", (ids[0],))}
            previous = {r["node_id"]: r["state_hash"] for r in self.conn.execute(
                "SELECT node_id, state_hash FROM event_nodes WHERE event_id=?", (ids[1],))} if len(ids) > 1 else None
            nodes = {}
            for r in self.conn.execute(
                    "SELECT n.node_id, COUNT(DISTINCT n.state_hash) AS states, COUNT(*) AS events "
                    "FROM event_nodes n JOIN queue_events e ON e.id=n.event_id WHERE e.workflow_id=? GROUP BY n.node_id", (wid,)):
                node_id = r["node_id"]
                changed = bool(previous is not None and node_id in latest and previous.get(node_id) != latest[node_id])
                nodes[node_id] = {"states": r["states"], "events": r["events"], "changed_in_latest": changed}
            return {"workflow_id": wid, "event_count": event_count, "latest_event_id": ids[0],
                    "previous_event_id": ids[1] if len(ids) > 1 else None, "nodes": nodes}

    def node_timeline(self, workflow_id, node_id, limit=100, collapse=True):
        """History of one node in one workflow, newest first.

        With collapse, consecutive events sharing a state become one entry that
        lists every event (and a capped strip of outputs) that state produced.
        ``changes`` is relative to the preceding distinct state.
        """
        limit = max(1, min(1000, int(limit)))
        with self.lock:
            rows = self.conn.execute(
                "SELECT e.id, e.ts_ms, n.state_hash FROM event_nodes n JOIN queue_events e ON e.id=n.event_id "
                "WHERE e.workflow_id=? AND n.node_id=? ORDER BY e.id ASC", (str(workflow_id or ""), str(node_id))).fetchall()
            entries = []
            for r in rows:
                if collapse and entries and entries[-1]["state_hash"] == r["state_hash"]:
                    entries[-1]["event_ids"].append(r["id"])
                    entries[-1]["last_ts_ms"] = r["ts_ms"]
                else:
                    entries.append({"state_hash": r["state_hash"], "event_ids": [r["id"]], "first_ts_ms": r["ts_ms"], "last_ts_ms": r["ts_ms"]})
            hashes = {e["state_hash"] for e in entries}
            states = {}
            if hashes:
                marks = ",".join("?" * len(hashes))
                for s in self.conn.execute(f"SELECT hash, class_type, inputs_json FROM node_states WHERE hash IN ({marks})", list(hashes)):
                    states[s["hash"]] = {"class_type": s["class_type"], "inputs": json.loads(s["inputs_json"])}
            previous = None
            for entry in entries:
                state = states[entry["state_hash"]]
                entry["class_type"] = state["class_type"]
                entry["inputs"] = state["inputs"]
                entry["changes"] = param_deltas(previous["inputs"], state["inputs"]) if previous else []
                previous = state
            shown = entries[::-1][:limit]
            all_ids = [i for e in shown for i in e["event_ids"]]
            outputs = self._outputs_for(all_ids)
            for entry in shown:
                strip = [o for i in entry["event_ids"] for o in outputs.get(i, [])]
                entry["outputs"] = strip[-OUTPUT_STRIP_CAP:]
                entry["event_count"] = len(entry["event_ids"])
            return {"workflow_id": str(workflow_id or ""), "node_id": str(node_id), "total": len(entries), "items": shown}
