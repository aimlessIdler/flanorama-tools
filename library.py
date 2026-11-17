"""Local library and Civitai metadata routes. Queueing works offline."""

import asyncio
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

import aiohttp
from aiohttp import web
from server import PromptServer

from .router import canonical_filename, lora_files, read_config, resolve_lora

HOSTS = {"com": "civitai.com", "red": "civitai.red"}
EMPTY_LIBRARY = {"favorites": [], "usage": {}, "presets": {}}
SCHEMA = """
CREATE TABLE IF NOT EXISTS file_hash (
    path TEXT PRIMARY KEY, size INTEGER, modified INTEGER, changed INTEGER, digest TEXT
);
CREATE TABLE IF NOT EXISTS file_alias (name TEXT PRIMARY KEY, digest TEXT);
CREATE TABLE IF NOT EXISTS metadata (
    digest TEXT, source TEXT, data TEXT, PRIMARY KEY (digest, source)
);
CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY, data TEXT);
"""


@contextmanager
def database(path):
    with closing(sqlite3.connect(path, timeout=10)) as connection, connection:
        connection.executescript(SCHEMA)
        yield connection


def user_database(request):
    manager = PromptServer.instance.user_manager
    path = manager.get_request_user_filepath(request, "lora-router.sqlite3")
    if not path:
        raise ValueError("ComfyUI could not resolve the user directory.")
    return path


def identity(db, name, files, allow_missing=False):
    try:
        path = Path(resolve_lora(name, files)).resolve()
        stat = path.stat()
    except FileNotFoundError:
        if not allow_missing:
            raise
        with database(db) as connection:
            row = connection.execute("SELECT digest FROM file_alias WHERE name = ?", (name,)).fetchone()
        return row[0] if row else None
    fingerprint = (str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    with database(db) as connection:
        result = connection.execute(
            "SELECT digest FROM file_hash WHERE path=? AND size=? AND modified=? AND changed=?", fingerprint
        ).fetchone()
    if result:
        digest = result[0]
    else:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        after = path.stat()
        if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != fingerprint[1:]:
            raise ValueError("The LoRA changed during lookup. Try again after the file finishes writing.")
    with database(db) as connection:
        connection.execute("INSERT OR REPLACE INTO file_hash VALUES (?,?,?,?,?)", (*fingerprint, digest))
        connection.execute("INSERT OR REPLACE INTO file_alias VALUES (?,?)", (name, digest))
    return digest


def cached_metadata(db, digest):
    with database(db) as connection:
        records = connection.execute("SELECT source, data FROM metadata WHERE digest = ?", (digest,))
        return {source: json.loads(data) for source, data in records}


def save_metadata(db, digest, source, record):
    with database(db) as connection:
        connection.execute("BEGIN IMMEDIATE")
        found = connection.execute("SELECT data FROM metadata WHERE digest = ? AND source = ?", (digest, source)).fetchone()
        old = json.loads(found[0]) if found else {}
        history = old.get("history", [])
        if old and (old["versionId"], old["trainedWords"]) != (record["versionId"], record["trainedWords"]):
            snapshot = {field: old[field] for field in ("versionId", "trainedWords", "retrieved", "page")}
            history.append(snapshot)
        record["history"] = history
        connection.execute("INSERT OR REPLACE INTO metadata VALUES (?,?,?)", (digest, source, json.dumps(record)))
    return record


class LookupError(Exception):
    pass


async def read_civitai(session, host, route):
    async with session.get(f"https://{host}/api/v1/{route}", allow_redirects=False) as response:
        if response.status == 404:
            raise LookupError("No matching record")
        if response.status in (401, 403):
            raise LookupError(f"Access denied (HTTP {response.status})")
        if response.status != 200:
            raise LookupError(f"HTTP {response.status}")
        chunks = bytearray()
        async for chunk in response.content.iter_chunked(65536):
            chunks.extend(chunk)
            if len(chunks) > 4_000_000:
                raise LookupError("Response is too large")
        record = json.loads(chunks)
        if not isinstance(record, dict):
            raise LookupError("Unexpected API response")
        return record


async def fetch_metadata(session, db, digest, source):
    host = HOSTS[source]
    try:
        version = await read_civitai(session, host, f"model-versions/by-hash/{digest}")
        version_id = version.get("id")
        model_id = version.get("modelId")
        if type(version_id) is not int or type(model_id) is not int:
            raise LookupError("Model/version ID missing from response")
        words = version.get("trainedWords", [])
        if not isinstance(words, list) or any(not isinstance(word, str) for word in words):
            raise LookupError("Unexpected trainedWords format")
        model = version.get("model")
        model = model if isinstance(model, dict) else {}
        try:
            model = await read_civitai(session, host, f"models/{model_id}")
        except (LookupError, aiohttp.ClientError, TimeoutError, ValueError):
            pass  # Version-level metadata is still available.
        creator = model.get("creator")
        record = {
            "versionId": version_id,
            "modelId": model_id,
            "name": model.get("name") or version.get("name") or "",
            "version": version.get("name") or "",
            "baseModel": version.get("baseModel") or "",
            "creator": creator.get("username", "") if isinstance(creator, dict) else "",
            "description": version.get("description") or model.get("description") or "",
            "trainedWords": words,
            "retrieved": datetime.now(timezone.utc).isoformat(),
            "page": f"https://{host}/models/{model_id}?modelVersionId={version_id}",
        }
        record = await asyncio.to_thread(save_metadata, db, digest, source, record)
        return source, "Retrieved", record
    except LookupError as error:
        return source, str(error), None
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return source, "Source unavailable", None


def recall(db, names):
    files = lora_files()
    result = {}
    for name in names:
        digest = identity(db, name, files, allow_missing=True)
        records = cached_metadata(db, digest) if digest else {}
        result[name] = {
            source: list(dict.fromkeys(word for item in [record, *record.get("history", [])] for word in item["trainedWords"]))
            for source, record in records.items()
        }
    return result


def update_library(db, mutation=None):
    with database(db) as connection:
        if mutation:
            connection.execute("BEGIN IMMEDIATE")
        found = connection.execute("SELECT data FROM library WHERE id=1").fetchone()
        library = json.loads(found[0]) if found else json.loads(json.dumps(EMPTY_LIBRARY))
        if not mutation:
            return library
        action = mutation.get("action")
        if action in ("favorite", "used"):
            names = mutation.get("files", [])
            if not isinstance(names, list) or not 1 <= len(names) <= 512:
                raise ValueError("Select at least one LoRA.")
            names = list(dict.fromkeys(canonical_filename(name) for name in names))
            if action == "favorite":
                name = names[0]
                favorites = library["favorites"]
                if name in favorites:
                    favorites.remove(name)
                else:
                    favorites.append(name)
            else:
                now = datetime.now(timezone.utc).isoformat()
                for name in names:
                    count = library["usage"].get(name, {}).get("count", 0)
                    library["usage"][name] = {"count": count + 1, "last": now}
        elif action in ("save", "delete"):
            name = mutation.get("name")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
                raise ValueError("Preset names must contain 1–100 characters.")
            name = name.strip()
            if action == "save":
                if name in library["presets"] and mutation.get("replace") is not True:
                    raise ValueError("A preset with that name already exists.")
                library["presets"][name] = read_config(mutation.get("config"))
            else:
                library["presets"].pop(name, None)
        else:
            raise ValueError("Unknown library operation.")
        connection.execute("INSERT OR REPLACE INTO library VALUES (1,?)", (json.dumps(library),))
        return library


def endpoint(handler):
    async def handle(request):
        try:
            return web.json_response(await handler(request))
        except (ValueError, KeyError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except FileNotFoundError as error:
            return web.json_response({"error": str(error)}, status=404)
        except (OSError, sqlite3.Error):
            return web.json_response({"error": "Could not access the LoRA library on the ComfyUI server."}, status=500)
    return handle


def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/lora-router/files")
    @endpoint
    async def files(_):
        return {"files": await asyncio.to_thread(lambda: list(lora_files()))}

    @routes.get("/lora-router/library")
    @endpoint
    async def get_library(request):
        return await asyncio.to_thread(update_library, user_database(request))

    @routes.post("/lora-router/library")
    @endpoint
    async def post_library(request):
        payload = await request.json()
        if not isinstance(payload, dict) or not payload:
            raise ValueError("Invalid library operation.")
        return await asyncio.to_thread(update_library, user_database(request), payload)

    @routes.post("/lora-router/metadata")
    @endpoint
    async def metadata(request):
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Invalid metadata request.")
        name = canonical_filename(payload.get("file"))
        sources = payload.get("sources", list(HOSTS))
        if not isinstance(sources, list) or any(source not in HOSTS for source in sources):
            raise ValueError("Invalid metadata source.")
        db = user_database(request)
        digest = await asyncio.to_thread(lambda: identity(db, name, lora_files(), allow_missing=True))
        if not digest:
            raise FileNotFoundError(f"LoRA not found: {name}")
        records = await asyncio.to_thread(cached_metadata, db, digest)
        status = {source: "Cached" for source in records}
        if payload.get("lookup") is True:
            pending = [source for source in dict.fromkeys(sources) if source not in records or payload.get("refresh") is True]
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as session:
                results = await asyncio.gather(*(fetch_metadata(session, db, digest, source) for source in pending))
            for source, outcome, record in results:
                status[source] = outcome
                if record:
                    records[source] = record
        return {"sha256": digest, "records": records, "status": status}

    @routes.post("/lora-router/triggers")
    @endpoint
    async def triggers(request):
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("Invalid trigger request.")
        names = payload.get("files", [])
        if not isinstance(names, list) or len(names) > 512:
            raise ValueError("Select up to 512 LoRAs for trigger recall.")
        names = list(dict.fromkeys(canonical_filename(name) for name in names))
        return {"triggers": await asyncio.to_thread(recall, user_database(request), names)}
