# ComfyUI Pill Packer

Collapse selected nodes and arrange them in tidy, tightly spaced pill stacks.
Works with expanded nodes, collapsed nodes, and mixed selections.

Install [Flanorama Tools](../README.md#install-the-preview), then select nodes and press **Alt + Shift + P** or choose **Pill Packer → Pack selection…** from the context menu. On newer frontends, the same command appears on the selection toolbar and under **Edit → Pill Packer**.

## Use

Choose **Screenshot style** to create a stack per node type, equalize widths
within each stack, color by type, and wrap everything in one group. The default
**Type stacks** preset preserves existing colors and groups.

| Setting | Choices |
| --- | --- |
| Layout | One vertical stack, a stack per type/category, or balanced columns |
| Order | Current visual order, title, type, or connection order |
| Gaps | Vertical and horizontal distances in the active canvas's grid units |
| Width | Fit each title, equal per stack, equal across the selection, or fixed |
| Minimum/maximum | Grid units; maximum 0 removes the cap; fixed width uses its own value and the minimum |
| Minimum fits longest title | Measures the longest full title in each stack, including controls, and uses it as that stack's minimum width |
| Colors | Preserve existing colors, or color by type, category, or stack |
| Groups | Leave alone, wrap everything, wrap each stack, or fit an existing containing group |
| Pinned nodes | Leave in place by default; turn this off to include them |

The live layout preview changes no workflow data. **Pack selection** applies
the whole operation as one undoable change. Escape or Cancel discards changes
in the dialog. **Pack with last settings** repeats the last successful pack
without opening the dialog. All three commands are available in ComfyUI's
keybinding settings; the repeat command has no default shortcut to avoid
claiming another key combination.

Save named presets in the dialog. Presets and last-used options are stored in
the browser for that ComfyUI origin. Width overrides are saved in the workflow
itself, under each node's `properties.pill_packer` field.

Enable **Minimum fits longest title in each stack** to keep every name fully
visible. This measures actual rendered text width, so wide letters and custom
fonts are accounted for. The title minimum takes priority over smaller maximum
or fixed widths; with equal widths across the selection, the largest required
minimum applies to every stack. The numeric minimum still acts as a floor.

**Restore natural collapsed widths** removes Pill Packer's width overrides
from selected nodes. It keeps their positions, collapsed state, colors, and
groups. Use normal Undo to reverse a complete packing action.

## Behaviour details

- Nodes already collapsed remain collapsed. Expanded sizes, widget values,
  links, titles, and execution modes are preserved.
- Width measurement includes room for the collapse control and ports. Long
  titles are shortened visually; the underlying title is unchanged. A minimum
  control-space width is enforced even if a smaller width limit is requested.
- Standard canvas pill titles use bright white text instead of the canvas's
  gray title fallback. Explicit custom node title colors and custom title
  renderers are respected, as is normal opacity for muted/bypassed nodes.
- Grid snapping can make the actual vertical gap slightly larger than the
  requested minimum. At a zero gap, the next pill starts at the next grid
  boundary after the previous pill's visible bottom.
- Visual order is top-to-bottom within type/category stacks; balanced columns
  use left-to-right, then top-to-bottom order. Connection-order ties and cycles
  use stable node IDs. Running the same pack twice leaves positions unchanged.
- Colors are deterministic: the same type/category gets the same color on
  future packs. Custom node categories use their top-level category.
- Auto-created groups are reused for the same set of nodes and grouping mode.
  Group padding and a title area are included. Per-stack groups reserve enough
  horizontal space to avoid overlapping one another.
- Fitting an existing group chooses the smallest unlocked group containing
  all included nodes (or the selected containing group). Its other node
  contents remain within the new bounds. Pinned groups are not resized.
- Noncollapsible nodes are skipped. Group and reroute selections are ignored;
  select the actual nodes to include. Subgraphs use the active canvas graph.
- Packing starts at the selection's top-left. It does not search the entire
  workflow for free space or rearrange unselected nodes.

## Compatibility and limits

This package uses ComfyUI's JavaScript extension APIs. It supports canvas
nodes through per-instance collapsed-geometry hooks and Vue/Nodes 2.0 through
its `.lg-node[data-node-id]` DOM contract. Expanded sizes are never overwritten
to force a collapsed width. Existing custom title renderers are retained and
clipped to the selected width.

Validation includes a headless browser suite against the real published
`@comfyorg/litegraph` **0.17.2** graph/canvas engine, plus tests of the current
Vue renderer's DOM sizing contract. It has **not** been tested inside your
installed ComfyUI or a complete running Vue frontend. Third-party node chrome
and future frontend changes may require compatibility adjustments. The
selection-toolbar and menu hooks also depend on frontend version; the
keyboard command is an alternative entry point.

Workflow layouts and standard colors remain usable if the extension is
removed; custom collapsed-width overrides require the extension to render.
The package performs no network requests.

## Development

Run `npm test` from the Flanorama Tools folder for the packing, transaction, and renderer tests.
