import { outputBranch } from './state.js';

const inputName = (kind, branch) => `${kind.toLowerCase()}_${branch}`;
const inputBranch = slot => Number(slot.name.split('_').at(-1));
const slotGap = 21;
const foldedX = (width, isInput) => isInput ? 4 : width - 5;

function inputConnected(node, index) {
  const slot = node.inputs[index];
  return slot.isConnected || slot.link != null || slot.floatingLinkIds?.size > 0 ||
    [...(node.graph?.floatingLinks?.values() ?? [])].some(link => link.target_id === node.id && link.target_slot === index);
}

function outputConnected(node, index) {
  const slot = node.outputs[index];
  return slot.isConnected || slot.links?.length > 0 || slot.linkIds?.size > 0 || slot.floatingLinkIds?.size > 0 ||
    [...(node.graph?.floatingLinks?.values() ?? [])].some(link => link.origin_id === node.id && link.origin_slot === index);
}

function inputActive(config, slot) {
  return inputBranch(slot) <= (config.mode === 'shared' ? 1 : config.count) && (slot.type !== 'CLIP' || config.clip);
}

function outputActive(config, index) {
  return outputBranch(index) <= config.count && (index % 2 === 0 || config.clip);
}

export function blockedPortChange(node, next) {
  const inputs = node.inputs.filter((slot, index) => !inputActive(next, slot) && inputConnected(node, index));
  const outputs = node.outputs.filter((slot, index) => !outputActive(next, index) && outputConnected(node, index));
  const connected = [...inputs.map(slot => `${slot.label || slot.name} input`), ...outputs.map(slot => `${slot.name} output`)];
  return connected.length ? `Disconnect ${connected.join(', ')} before applying this change.` : '';
}

export function syncSockets(node, config) {
  const inputCount = config.mode === 'shared' ? 1 : config.count;
  for (let index = node.inputs.length - 1; index >= 0; index--) {
    const slot = node.inputs[index];
    if (!inputActive(config, slot) && !inputConnected(node, index)) node.removeInput(index);
  }
  for (let branch = 1; branch <= inputCount; branch++) {
    for (const type of config.clip ? ['MODEL', 'CLIP'] : ['MODEL']) {
      const name = inputName(type, branch);
      if (!node.inputs.some(slot => slot.name === name)) node.addInput(name, type);
    }
  }
  const retained = node.outputs.reduce((count, slot, index) => outputConnected(node, index) ? index + 1 : count, 0);
  const outputCount = Math.max(config.count * 2 - (config.clip ? 0 : 1), retained);
  while (node.outputs.length > outputCount) node.removeOutput(node.outputs.length - 1);
  while (node.outputs.length < outputCount) {
    const index = node.outputs.length;
    const type = index % 2 === 0 ? 'MODEL' : 'CLIP';
    node.addOutput(`${type} ${outputBranch(index)}`, type);
  }
}

export function layoutSockets(node, config, expanded, titleHeight) {
  const width = node.size[0];
  const place = (slots, isInput) => {
    let row = 0;
    slots.forEach((slot, index) => {
      const connected = isInput ? inputConnected(node, index) : outputConnected(node, index);
      const active = (isInput ? inputActive(config, slot) : outputActive(config, index)) || connected;
      const branch = isInput ? inputBranch(slot) : outputBranch(index);
      const type = slot.type;
      const label = isInput && config.mode === 'shared' && branch === 1 ? type : `${type} ${branch}`;
      if (slot.label !== label) slot.label = label;
      const x = expanded ? (isInput ? 10 : width - 10) : foldedX(width, isInput);
      const y = expanded ? row * slotGap + 12 : -titleHeight / 2 + (config.clip ? (type === 'CLIP' ? 5 : -5) : 0);
      const next = active ? [x, y] : [-10000, -10000];
      if (slot.pos?.[0] !== next[0] || slot.pos?.[1] !== next[1]) slot.pos = next;
      if (active) row++;
    });
    return row;
  };
  const rows = Math.max(place(node.inputs, true), place(node.outputs, false));
  node.widgets_start_y = expanded ? rows * slotGap + 3 : 3;
}

export function drawFoldedSockets(ctx, node, config, colors, titleHeight) {
  ctx.save();
  for (const x of [foldedX(node.size[0], true), foldedX(node.size[0], false)]) {
    for (const type of config.clip ? ['MODEL', 'CLIP'] : ['MODEL']) {
      const y = -titleHeight / 2 + (config.clip ? (type === 'CLIP' ? 5 : -5) : 0);
      ctx.fillStyle = colors?.[type] || (type === 'CLIP' ? '#ffd500' : '#b39ddb');
      ctx.strokeStyle = '#23232a';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawActiveSockets(ctx, node, config, options) {
  // The native renderer expects concrete slots. Keep placeholders in the graph,
  // while omitting them from this node's drawing pass.
  const { fromSlot, colorContext, editorAlpha, lowQuality } = options;
  const slots = [
    ...node._concreteInputs.filter((slot, index) => inputActive(config, slot) || inputConnected(node, index)),
    ...node._concreteOutputs.filter((slot, index) => outputActive(config, index) || outputConnected(node, index)),
  ];
  ctx.save();
  for (const slot of slots) {
    const compatible = !fromSlot || slot.isValidTarget(fromSlot);
    ctx.globalAlpha = compatible ? editorAlpha : editorAlpha * 0.4;
    slot.draw(ctx, { colorContext, lowQuality, highlight: compatible && node._isMouseOverSlot(slot) });
  }
  ctx.restore();
}

export function handleFoldedAnchor(event, app, controllers) {
  const canvas = app.canvas;
  if (!canvas || canvas.read_only || event.button !== 0 || event.target !== canvas.canvas) return;
  const point = canvas.convertEventToCanvasOffset(event);
  const node = canvas.graph?.getNodeOnPos(point[0], point[1]);
  const controller = node && controllers.get(node);
  if (!controller || controller.prefs.portsOpen || node.flags.collapsed) return;
  const x = point[0] - node.pos[0];
  const y = point[1] - node.pos[1];
  const nearAnchor = x <= foldedX(node.size[0], true) + 6 || x >= foldedX(node.size[0], false) - 16;
  if (!nearAnchor || y > -1 || y < -controller.titleHeight + 1) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  controller.togglePorts();
}
