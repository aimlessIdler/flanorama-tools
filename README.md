# Flanorama Tools for ComfyUI

Route LoRAs to several model branches, revisit prompts and node settings, organize a busy canvas, and pick the exact frame that starts the next scene.

| Tool | Where to find it |
| --- | --- |
| [LoRA Router](docs/LoRA-Router.md) | Search **LoRA Router**. Route a LoRA stack across up to 64 MODEL/CLIP pairs. |
| [Prompt History](docs/Prompt-History.md) | Search **Prompt History**. Browse, save, and reuse prompts across workflows. |
| [Workflow History](docs/Prompt-History.md#workflow-history) | Open **Edit → Flanorama → Workflow History** to compare queued runs across the workflow. Inspect individual nodes from the change map. |
| [Pill Packer](docs/Pill-Packer.md) | Select nodes and press **Alt + Shift + P** or use **Pill Packer → Pack selection…**. |
| Markdown Note | Search **Markdown Note (Flanorama)**. Switch between Edit and Preview. Copy fenced code straight from the note. |
| Simple Sampler & Scheduler | Connect its SAMPLER and SCHEDULER outputs to converted sampler widgets to share one setting across several samplers. |
| Variable Toggle | Set a literal placeholder such as `{VAR}`, enter two terms, and choose which term to use. Replace the first occurrence or every occurrence. |
| Frame Select (Scene Stitch) | Scrub through the tail of a clip or select an exact frame by number. Use the selected frame to start the next scene. |

## Install the preview

1. Place the `Flanorama-Tools` folder in `ComfyUI/custom_nodes` so that `Flanorama-Tools/__init__.py` is directly inside it.
2. With the Python that runs ComfyUI, run `python -m pip install -r custom_nodes/Flanorama-Tools/requirements.txt` from the ComfyUI directory. The embedded Windows build uses its own `python.exe`.
3. Disable the older copies described below, restart ComfyUI, and refresh the browser.

### Move from standalone versions

Back up your workflows and the Prompt History and LoRA Router SQLite databases from your ComfyUI user directory. Flanorama Tools opens those databases at the same paths. The original `FlaMarkdownNote` and the other nodes keep their workflow IDs and widget order. The standalone Markdown Note used ComfyUI's built-in `MarkdownNote` ID. To use the Flanorama editor and Copy buttons on those notes, replace them with **Markdown Note (Flanorama)** and copy the text across.

Disable the previous **FlaNodes** preview and standalone copies of **LoRA Router**, **Prompt History** (including v0.4), **Pill Packer**, **Markdown Note**, and **Frame Select**. If you still need the bespoke scene nodes in `comfyui-flanodes`, keep that package and remove its registration entries for `SimpleSamplerConfig`, `VariableToggle`, and `FlaMarkdownNote`, plus its Markdown JavaScript extension. Duplicate copies can register the same node IDs or server routes.

### Stitch scenes with Frame Select

Connect the current clip's **IMAGE** batch, then connect **selected_frame** to the next scene's starting image input. Use **truncated_batch** for the current scene. It ends immediately before the handoff frame, so the next scene can start there without repeating the boundary. Selecting the first frame returns it in both outputs to avoid passing an empty image batch downstream.

**Review in browser** opens the last `review_frames` previews on the browser that queued the job. Use the scrubber or arrow keys and confirm with **Use frame**. Escape or **Cancel review** interrupts the job. ComfyUI's Interrupt command also ends the review. Unanswered reviews expire after five minutes.

For unattended queues, use **Exact frame** with a one-based `frame_number`, or **Last frame**. The scene-name fields label the review. Existing workflows can still load the legacy `enable_looping` field. Wire scene sequencing in the graph.

### Local data and external requests

Markdown preview renders on the ComfyUI server. Remote images linked in a note load in the browser. Prompt History shares one SQLite archive across the server. Node Timeline logs accepted workflow inputs and output file references even when the workflow contains no Prompt History node. Anyone with access to the history routes on a shared ComfyUI server can browse that archive.

LoRA Router uses Civitai only when you request metadata. Local inference does not require it. The LoRA Router's custom controls target the Legacy frontend. Workflow History records the executable graph. Individual node restore actions currently support top-level workflow nodes.

## Development

Run `npm test` for the JavaScript suites and `python -m unittest discover -s tests` with ComfyUI's Python for the backend suites. Run `python tools/package.py` with Python 3.11 or later to create an install ZIP under `dist/`.

At startup, the terminal banner shows the package version and registered node count. It stacks the text below the logo in narrow terminals and uses a plain summary with `NO_COLOR` set. The logo also renders through Windows launchers that pipe terminal output.

## Publishing

1. The registered Comfy Registry publisher is **@flanorama**. The pack ID is `flanorama-tools`.
2. Use the public `aimlessIdler/flanorama-tools` repository as the release source. The pack is distributed under the MIT License.
3. Generate a publisher API key in Comfy Registry and add it as the GitHub Actions repository secret `REGISTRY_ACCESS_TOKEN`.
4. In GitHub, open **Actions → Publish to Comfy Registry → Run workflow**. The workflow publishes the version in `pyproject.toml`. For later releases, increment that version before dispatching the workflow.
5. Verify the resulting listing and install from Manager into a fresh ComfyUI user directory. You can also publish by running `comfy node publish` from the repository root. [Comfy Registry publishing guide](https://docs.comfy.org/registry/publishing)
