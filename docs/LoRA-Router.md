# LoRA Router for ComfyUI

Apply an ordered LoRA stack to up to **64 independent MODEL outputs**. Each row can use one weight on every output or store a separate weight and enable toggle for each output. The node targets ComfyUI **0.44.0** with frontend **1.58.5**, using **Legacy** node UI.

## Use

Install [Flanorama Tools](../README.md#install-the-preview) and search for **LoRA Router** in the node menu. Click **Ports ▸** in the footer to expose the sockets. Connect your MODEL on the left, then connect an output to a sampler or another MODEL input. Fold the ports again when you're done wiring.

## Weights and outputs

- Drag the grip to reorder a row. The keyboard shortcut is **Alt + ↑ / ↓** with the grip focused.
- The row's **On/Off** controls the LoRA across all outputs. Hold the pointer down on a toggle and drag vertically to apply that state to each toggle you cross. Each row is visited once per stroke. The footer **All** toggle includes every row. The **Off** eye button shows or hides disabled rows after you release a painting stroke.
- Clicking a weight selects the entire value for replacement. The left and right chevrons use the increment set with the gear in the footer.
- The split-arrow button opens the routing controls. The up chevron closes them. Turn **Route** on to use independent values. The first activation with the toggle copies the primary weight to the configured branches. Toggle **Route** off to apply the primary weight everywhere. Switching it back on restores the individual settings.
- Routing `+` turns **Route** on and adds the lowest missing route for that LoRA. If every configured output already has a route, it adds a MODEL socket. On a fresh row, it starts with MODEL 1 and adds MODEL 2. Routing `−` activates removal mode. Use the red `×` over any module, including MODEL 1, to clear that LoRA's assignment. Socket numbers and wires are preserved. The next `+` reuses the lowest available number. Click `−` again or close the routing controls to exit removal mode.
- Use **Shared base** to create variants of one MODEL, or **Per-output bases** to connect separate MODEL inputs. Each branch starts from its own input and applies the enabled rows in order. LoRAs must be compatible with the model architecture on that branch.
- **CLIP inputs and outputs** are opt-in. A paired CLIP follows the same weight and enable settings as its MODEL. With a shared base, a single CLIP input supplies all pairs. The MODEL branch can run with its CLIP input unconnected.
- Folded sockets keep existing wires attached. Open **Ports** to create or change connections. Settings prevent removing an output or hiding an input that still has a connection.

The 64-pair backend schema gives every socket a stable typed index. Only the configured sockets appear on the node. In API workflows, MODEL N uses index `2 * (N - 1)` and CLIP N uses the next index.

## Picker, presets and triggers

**+** opens the searchable file picker. Click a file to load it, or check several files and choose **Add selected**. Star a file to reach it from **⭐ Favorites**. The picker also tracks recent and frequently added files. **Presets** saves a named stack with its order, toggles and per-output weights. Replace and Append apply the stack to the current output numbers. Set the output count separately in Settings.

The `i` button matches the local file's SHA-256 against Civitai. It checks **civitai.com** (the destination of `civit.ai`) and **civitai.red** by default. Each source reports its own status. **Refresh** retries the selected sources. Metadata is retrieved on demand, separately from graph execution. Access-denied, missing, or unreachable records are reported in the dialog.

The node stores documented `trainedWords` verbatim with their source and version. A changed source response keeps the previous documented words in history. **Triggers** recalls saved phrases offline for the selected output, or for a single file from its information panel. Choose phrases to copy, or append them to a selected editable prompt field, such as the text field of **CLIP Text Encode**. This works independently of the router's optional CLIP sockets.

Favorites, usage, presets and cached metadata live in `lora-router.sqlite3` in your ComfyUI user directory. The cache has no expiry. Back up that database to move the library to another installation. The node's settings and current stack travel in the workflow JSON.
