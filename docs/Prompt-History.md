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

## Workflow History

Open **Edit → Flanorama → Workflow History**, or right-click the canvas or any node and choose **Workflow History…**. The default view compares each queued run with the preceding run of the same workflow.

Select a run by date and time. The change map uses the saved canvas positions and marks changed, unchanged, added, and removed nodes with labeled colors. Hover or focus a node for a quick summary. Click it to inspect its changes and open its individual history when the matching node is on the canvas.

Parameter changes show the old value struck through and the new value beside it. Structured widget values expand into changed fields, for example `config.weight: 1.2 → 1.3`. JSON objects are compared by field and arrays by index. Added and removed fields are marked explicitly. Unchanged fields and lists are omitted. Values stay literal, including selection indices. These comparisons apply to any node type. Runs recorded before v0.1.1 use a grid when canvas positions are unavailable. The history covers the executable graph submitted for a run, including its links. Muted and unused nodes omitted by ComfyUI are outside that run.

**Outputs from this run** lists the files reported for that execution. Files can be opened while they remain available on the server. Temporary previews may expire.

### Individual node history

Right-click a node and choose **Node timeline…**, or use **Node history** in a run's node detail. **All runs** returns to the workflow view. Canvas history badges are removed in v0.1.1.

Restore writes matching widget values in an undoable canvas change. Restoring one field inside a structured widget restores that widget's recorded value. Link inputs and hidden inputs without matching widgets are displayed without a restore action. Subgraph internals remain outside the node restore UI.

The database is upgraded automatically, preserving the existing archive. No new history is synthesized for past runs.

Read endpoints under `/prompt_history/timeline/` include `events`, `event`, `diff`, `workflow`, `node`, and `run?id=`. The run endpoint returns the preceding-run comparison and saved canvas positions.
