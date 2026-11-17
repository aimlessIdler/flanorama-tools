# Prompt History and Node Timeline

A deliberately small ComfyUI node: multiline prompt editor, **◀ older / newer ▶**, **Save**, **Manage**. It emits an ordinary **STRING** output named **PROMPT**. There is no history count limit unless you set one.

Install [Flanorama Tools](../README.md#install-the-preview), then add **Prompt History**. Connect its **PROMPT** output to the **text** input of **CLIP Text Encode**, converting that widget to an input if needed.

## Use

- **◀** opens the most recently stored prompt, then navigates older entries.
- **▶** navigates newer entries; after the newest, it returns to your unsaved draft.
- **Save** stores the current editor text **without queueing anything**.
- **Manage…** searches saved prompts and supports Load, Pin/Unpin, Delete, export/import JSON, Clear unpinned, Clear all, and optional `max_entries` (0 = unlimited).
- The history is **global to this ComfyUI server**. All Prompt History nodes and workflows access the same archive.
- Identical prompt text is kept as **one history entry**, with counters and last-used timestamp updated when reused.

## Automatic recording

When ComfyUI **accepts** a `POST /prompt` or `/api/prompt` submission, the extension records the Prompt History text. It reads executable node inputs and, where provided, the visual workflow metadata for disconnected Prompt History nodes. This happens after validation, so invalid requests are not stored. It applies to normal frontend jobs **and jobs submitted through `/prompt` by another extension**, including sweep managers. There is no modification of the queue, scheduler, graph, sampler, or generated filenames.

An optional **external_prompt** STRING input lets you feed a custom prompt-list node through Prompt History. Since its actual value is not available in the serialized queued graph (ComfyUI represents it as a link), it is recorded **when the node executes**, not immediately upon queue acceptance. Jobs canceled before execution cannot have that dynamically resolved text recorded. This is a ComfyUI graph evaluation distinction, not a history limit.

When `external_prompt` is connected, its evaluated value overrides the editor's `prompt` for output. Use the editor without that connection for the simplest experience.

## Storage and backups

A persistent SQLite archive is stored at:

`<ComfyUI user directory>/prompt_history/history.sqlite3`

This survives ComfyUI restarts and workflow changes. The **Export** command creates a JSON backup; **Import** merges saved entries. Delete / Clear operations cannot be undone unless you have exported a backup. Pinned entries are protected from automatic history-limit pruning. If pinned entries alone exceed the limit, the limit is soft until you unpin or delete them.

## Node Timeline

Each accepted queue submission is recorded as an event. The timeline keeps each node's type and input values, including links, and associates available output file references with the execution that produced them. It uses the same SQLite database as Prompt History.

Read endpoints (all GET, under `/prompt_history/timeline/`):

- `events?workflow_id=&limit=&before_id=` lists events, newest first.
- `event?id=` returns one event with every node's state and its outputs.
- `diff?a=&b=` returns unchanged / changed / added / removed per node, with per-parameter old and new values.
- `workflow?workflow_id=` returns per-node state counts and which nodes changed in the latest queue (drives the canvas badges).
- `node?workflow_id=&node_id=&limit=&collapse=1` returns one node's state history in one workflow, newest first, each state with the parameters it changed and the outputs it produced.

### Open a node’s history

- Nodes with more than one recorded state get a small `⏱ n` badge in the title bar, amber when the node changed in the latest queue.
- Click the badge, or right-click a node and choose **Node timeline…**, to open a docked panel. Each entry shows the parameters that changed (old to new), the outputs that state produced, an "on canvas" tag when the node currently matches it, and **Restore** buttons for the whole state or a single parameter.
- Restore writes widget values only. Link inputs (wiring) and hidden inputs are listed but skipped.
- Nodes inside subgraphs are not supported yet. If the badge does not appear in your frontend, the right-click entry is the fallback.
- History only references output files. A preview is available while its file remains on the ComfyUI server.
