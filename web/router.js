import { app } from '../../scripts/app.js';
import { Dialogs } from './dialogs.js';
import { blockedPortChange, drawActiveSockets, drawFoldedSockets, handleFoldedAnchor, layoutSockets, syncSockets } from './ports.js';
import { element, renderRows, widgetHeight } from './rows.js';
import { editorPrefs, enablePerOutput, MAX_OUTPUTS, newRow, nextRoute, NODE_TYPE, outputSetting, parseConfig, routeBranches } from './state.js';

const controllers = new WeakMap();
const MIN_WIDTH = 320;
const INITIAL_WIDTH = 535;
const PREFS_KEY = 'lora_router';
const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = new URL('./router.css', import.meta.url).href;
document.head.append(css);

class RouterController {
  constructor(node) {
    this.node = node;
    const originalWidget = node.widgets?.find(widget => widget.name === 'config');
    this.config = parseConfig(originalWidget?.value);
    this.prefs = editorPrefs(node.properties[PREFS_KEY]);
    this.titleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    this.root = element('div', { class: 'lora-router', 'aria-label': 'LoRA stack' });
    this.dialogs = new Dialogs(this);
    this.root.addEventListener('wheel', event => {
      const canvas = app.canvas?.canvas;
      if (!canvas) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
        clientX: event.clientX, clientY: event.clientY,
        ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey,
        metaKey: event.metaKey, bubbles: true, cancelable: true,
      }));
    }, { capture: true, passive: false });

    this.resizing = false;
    this.drag = null;
    this.paint = null;
    this.removeModes = new WeakSet();
    if (originalWidget) node.removeWidget(originalWidget);
    node.addDOMWidget('config', 'string', this.root, {
      margin: 6,
      hideOnZoom: false,
      getValue: () => JSON.stringify(this.config),
      setValue: value => { this.config = parseConfig(value); },
      getMinHeight: () => widgetHeight(this.config, this.prefs, node.size[0]),
      getMaxHeight: () => widgetHeight(this.config, this.prefs, node.size[0]),
    });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.root.querySelector('.lr-removing')) {
        this.removeModes = new WeakSet();
        this.reflow();
      }
      event.stopPropagation();
    });
    node.properties[PREFS_KEY] = this.prefs;
    node.size[0] = INITIAL_WIDTH;
  }

  notice(detail) {
    app.extensionManager.toast.add({ severity: 'warn', summary: 'LoRA Router', detail, life: 5000 });
  }

  reflow(redrawRows = true) {
    if (this.resizing) return;
    this.resizing = true;
    const { node, config, prefs } = this;
    try {
      const width = Math.max(MIN_WIDTH, node.size[0]);
      if (width !== node.size[0]) node.size[0] = width;
      layoutSockets(node, config, prefs.portsOpen, this.titleHeight);
      const height = node.widgets_start_y + widgetHeight(config, prefs, width);
      const widthChanged = this.renderedWidth !== width;
      this.renderedWidth = width;
      if (Math.abs(node.size[1] - height) >= 1) node.setSize([width, height]);
      if (redrawRows || widthChanged) renderRows(this);
      node.setDirtyCanvas(true, true);
    } finally {
      this.resizing = false;
    }
  }

  restore() {
    this.prefs = editorPrefs(this.node.properties[PREFS_KEY]);
    this.node.properties[PREFS_KEY] = this.prefs;
    this.sync();
  }

  sync() {
    this.resizing = true;
    try { syncSockets(this.node, this.config); }
    finally { this.resizing = false; }
    this.reflow();
  }

  edit(change, { ports = false, redraw = true } = {}) {
    if (app.canvas?.read_only) return;
    const graph = this.node.graph;
    graph?.beforeChange();
    try {
      change();
      if (ports) this.sync();
      else if (redraw) this.reflow();
      graph?.incrementVersion?.();
    } finally {
      graph?.afterChange(this.node);
    }
  }

  configurePorts(changes, prefs) {
    const next = { ...this.config, ...changes };
    if (!Number.isInteger(next.count) || next.count < 1 || next.count > MAX_OUTPUTS) {
      return `Choose an output count from 1 to ${MAX_OUTPUTS}.`;
    }
    const blocked = blockedPortChange(this.node, next);
    if (blocked) return blocked;
    this.edit(() => {
      Object.assign(this.config, changes);
      if (prefs) Object.assign(this.prefs, prefs);
    }, { ports: true });
    return '';
  }

  togglePorts() { this.edit(() => { this.prefs.portsOpen = !this.prefs.portsOpen; }); }

  expandRow(index) {
    this.edit(() => {
      this.prefs.expanded[index] = !this.prefs.expanded[index];
      if (!this.prefs.expanded[index]) this.removeModes.delete(this.config.rows[index]);
    });
  }

  addRoute(index) {
    const row = this.config.rows[index];
    const branch = nextRoute(row, this.config.count);
    if (branch === null) return;
    const grow = branch > this.config.count;
    this.edit(() => {
      if (grow) this.config.count = branch;
      this.prefs.expanded[index] = true;
      enablePerOutput(row, 1);
      row.outputs[branch] = { on: true, weight: row.weight };
      this.removeModes.delete(row);
    }, { ports: grow });
  }

  toggleRemoveMode(index) {
    if (app.canvas?.read_only) return;
    const row = this.config.rows[index];
    const active = !this.removeModes.delete(row);
    if (active) this.removeModes.add(row);
    this.reflow();
    this.root.querySelector(`[data-lr-row="${index}"] button[aria-label="Remove routes"]`)?.focus({ preventScroll: true });
  }

  removeRoute(index, branch) {
    const row = this.config.rows[index];
    this.edit(() => {
      delete row.outputs[branch];
      if (!routeBranches(row, this.config.count).length) this.removeModes.delete(row);
    });
  }

  togglePerOutput(index) {
    const row = this.config.rows[index];
    this.edit(() => {
      if (row.perOutput) {
        row.perOutput = false;
        this.removeModes.delete(row);
      }
      else enablePerOutput(row, this.config.count);
    });
  }

  toggleRow(index) {
    this.edit(() => { this.config.rows[index].on = !this.config.rows[index].on; });
  }

  toggleAll() {
    const rows = this.config.rows;
    if (!rows.length) return;
    const enable = rows.some(row => !row.on);
    this.edit(() => { for (const row of rows) row.on = enable; });
  }

  toggleHide() { this.edit(() => { this.prefs.hideOff = !this.prefs.hideOff; }); }

  startPaint(index, event) {
    if (event.button !== 0 || !event.isPrimary || app.canvas?.read_only) return;
    event.preventDefault();
    event.stopPropagation();
    this.paint?.abort();
    const abort = new AbortController();
    this.paint = abort;
    const pointer = event.pointerId;
    const on = !this.config.rows[index].on;
    const toggles = [...this.root.querySelectorAll('.lr-master')].map(button => ({
      button, row: this.config.rows[Number(button.closest('[data-lr-row]').dataset.lrRow)],
    }));
    const selected = new Set();
    const update = ({ button }, state) => {
      button.textContent = state ? 'On' : 'Off';
      button.setAttribute('aria-pressed', String(state));
      button.closest('[data-lr-row]').classList.toggle('lr-off', !state);
    };
    const mark = toggle => {
      if (selected.has(toggle)) return;
      selected.add(toggle);
      update(toggle, on);
    };
    mark(toggles.find(toggle => toggle.button === event.currentTarget));
    let previous = event;
    const move = event => {
      if (event.pointerId !== pointer) return;
      const minY = Math.min(event.clientY, previous.clientY);
      const maxY = Math.max(event.clientY, previous.clientY);
      for (const toggle of toggles) {
        const box = toggle.button.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right) continue;
        const previousInColumn = previous.clientX >= box.left && previous.clientX <= box.right;
        const top = previousInColumn ? minY : event.clientY;
        const bottom = previousInColumn ? maxY : event.clientY;
        if (top <= box.bottom && bottom >= box.top) mark(toggle);
      }
      previous = event;
    };
    const cancel = () => {
      for (const toggle of selected) if (toggle.button.isConnected) update(toggle, toggle.row.on);
      abort.abort();
      this.paint = null;
    };
    const finish = event => {
      if (event.pointerId !== pointer) return;
      move(event);
      cancel();
      this.edit(() => { for (const { row } of selected) row.on = on; });
    };
    const listeners = { signal: abort.signal, capture: true };
    window.addEventListener('pointermove', move, listeners);
    window.addEventListener('pointerup', finish, listeners);
    window.addEventListener('pointercancel', event => { if (event.pointerId === pointer) cancel(); }, listeners);
    window.addEventListener('blur', cancel, listeners);
  }

  toggleOutput(index, branch) {
    const row = this.config.rows[index];
    const current = outputSetting(row, branch);
    this.edit(() => { row.outputs[branch] = { ...current, on: !current.on }; });
  }

  setWeight(index, branch, weight, redraw = true) {
    const row = this.config.rows[index];
    if ((branch ? outputSetting(row, branch).weight : row.weight) === weight) return;
    this.edit(() => {
      if (!branch) row.weight = weight;
      else row.outputs[branch] = { ...outputSetting(row, branch), weight };
    }, { redraw });
  }

  addRows(files) { this.edit(() => this.config.rows.push(...files.map(newRow))); }
  replaceRow(index, file) { this.edit(() => { this.config.rows[index].file = file; }); }

  removeRow(index) {
    this.edit(() => {
      this.config.rows.splice(index, 1);
      this.prefs.expanded.splice(index, 1);
    });
  }

  applyPreset(rows, append) {
    this.edit(() => {
      if (append) this.config.rows.push(...rows);
      else {
        this.config.rows = rows;
        this.prefs.expanded = [];
      }
    });
  }

  moveRow(from, to) {
    if (from === to || to < 0 || to >= this.config.rows.length) return;
    this.edit(() => {
      const expanded = this.config.rows.map((_, index) => this.prefs.expanded[index] ?? false);
      this.config.rows.splice(to, 0, this.config.rows.splice(from, 1)[0]);
      expanded.splice(to, 0, expanded.splice(from, 1)[0]);
      this.prefs.expanded = expanded;
    });
    this.root.querySelector(`[data-lr-row="${to}"] .lr-handle`)?.focus({ preventScroll: true });
  }

  startDrag(index, event) {
    if (event.button !== 0 || app.canvas?.read_only) return;
    event.stopPropagation();
    this.drag?.abort();
    const drag = new AbortController();
    this.drag = drag;
    const pointer = event.pointerId;
    let destination = index;
    let mark;
    const move = event => {
      if (event.pointerId !== pointer) return;
      mark?.classList.remove('lr-drag-target');
      const row = [...this.root.querySelectorAll('[data-lr-row]')].find(item => {
        const bounds = item.getBoundingClientRect();
        return event.clientX >= bounds.left && event.clientX <= bounds.right &&
          event.clientY >= bounds.top && event.clientY < bounds.bottom;
      });
      if (!row) { destination = index; return; }
      destination = Number(row.dataset.lrRow);
      mark = row;
      if (destination !== index) mark.classList.add('lr-drag-target');
    };
    const finish = event => {
      if (event.pointerId !== pointer) return;
      if (event.type === 'pointerup') move(event);
      mark?.classList.remove('lr-drag-target');
      drag.abort();
      this.drag = null;
      if (event.type === 'pointerup') this.moveRow(index, destination);
    };
    const listeners = { signal: drag.signal, capture: true };
    window.addEventListener('pointermove', move, listeners);
    window.addEventListener('pointerup', finish, listeners);
    window.addEventListener('pointercancel', finish, listeners);
    window.addEventListener('blur', () => {
      mark?.classList.remove('lr-drag-target');
      drag.abort();
      this.drag = null;
    }, listeners);
  }
}

app.registerExtension({
  name: 'LoRA.Router',
  setup() {
    document.addEventListener('pointerdown', event => handleFoldedAnchor(event, app, controllers), true);
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const proto = nodeType.prototype;
    const created = proto.onNodeCreated;
    const configure = proto.onConfigure;
    const drawSlots = proto.drawSlots;
    const resize = proto.onResize;
    const computeSize = proto.computeSize;
    const removed = proto.onRemoved;


    proto.onNodeCreated = function (...args) {
      const result = created?.apply(this, args);
      if (controllers.has(this)) return result;
      const controller = new RouterController(this);
      controllers.set(this, controller);
      controller.sync();
      return result;
    };
    proto.onConfigure = function (...args) {
      const result = configure?.apply(this, args);
      controllers.get(this)?.restore();
      return result;
    };
    proto.onResize = function (...args) {
      resize?.apply(this, args);
      controllers.get(this)?.reflow(false);
    };
    proto.computeSize = function (...args) {
      const controller = controllers.get(this);
      if (!controller) return computeSize.apply(this, args);
      const height = (this.widgets_start_y ?? 3) + widgetHeight(controller.config, controller.prefs, this.size[0]);
      return [MIN_WIDTH, height];
    };
    proto.drawSlots = function (ctx, options) {
      const controller = controllers.get(this);
      if (!controller) return drawSlots.call(this, ctx, options);
      if (controller.prefs.portsOpen) drawActiveSockets(ctx, this, controller.config, options);
      else drawFoldedSockets(ctx, this, controller.config, app.canvas?.default_connection_color_byType, controller.titleHeight);
    };
    proto.onRemoved = function (...args) {
      const controller = controllers.get(this);
      controller?.dialogs.close();
      controller?.drag?.abort();
      controller?.paint?.abort();
      return removed?.apply(this, args);
    };
    const connectInput = proto.onConnectInput;
    const connectOutput = proto.onConnectOutput;
    proto.onConnectInput = function (...args) {
      const controller = controllers.get(this);
      if (controller && !controller.prefs.portsOpen) return false;
      return connectInput?.apply(this, args);
    };
    proto.onConnectOutput = function (...args) {
      const controller = controllers.get(this);
      if (controller && !controller.prefs.portsOpen) return false;
      return connectOutput?.apply(this, args);
    };
  },
});
