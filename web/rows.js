import { clampWeight, nextRoute, outputSetting, routeBranches } from './state.js';

export const ROW_HEIGHT = 30;
const MODULE_LINE = 27;
const MODULE_WIDTH = 99;
const MODULE_GAP = 5;
const RAIL_WIDTH = 47;
const RAIL_INLINE_WIDTH = 93;

export function element(tag, attrs = {}, text) {
  const item = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && value !== false) item.setAttribute(name, value === true ? '' : String(value));
  }
  if (text !== undefined) item.textContent = text;
  return item;
}

export function button(text, action, options = {}) {
  const item = element('button', {
    type: 'button', class: options.className, title: options.label,
    'aria-label': options.label, 'aria-pressed': options.pressed === undefined ? null : String(options.pressed),
    disabled: options.disabled,
  }, text);
  if (action) item.addEventListener('click', action);
  return item;
}

function routeLayout(moduleCount, width) {
  const available = width - 12;
  const footprint = count => count * (MODULE_WIDTH + MODULE_GAP);
  const inline = footprint(moduleCount) <= available - RAIL_INLINE_WIDTH;
  const rail = inline ? RAIL_INLINE_WIDTH : RAIL_WIDTH;
  const columns = Math.max(1, Math.floor((available - rail) / footprint(1)));
  const lines = Math.ceil(moduleCount / columns);
  return { inline, rail, lines: inline ? 1 : Math.max(2, lines), columns };
}

export function widgetHeight(config, prefs, width) {
  return 33 + config.rows.reduce((height, row, index) => {
    if (prefs.hideOff && !row.on) return height;
    const count = row.perOutput ? routeBranches(row, config.count).filter(branch => branch > 1).length : 0;
    const lines = prefs.expanded[index] ? routeLayout(count, width).lines : 0;
    return height + ROW_HEIGHT + lines * MODULE_LINE;
  }, 0);
}

function weightEditor(controller, index, branch, weight, enabled) {
  const { config } = controller;
  const target = branch ? `MODEL ${branch}` : config.count > 1 ? 'MODEL 1 · all outputs' : 'MODEL 1';
  const group = element('div', { class: 'lr-weight', role: 'group', 'aria-label': `${target} weight` });
  const entry = element('input', {
    type: 'text', inputmode: 'decimal', value: weight.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1'),
    'aria-label': `${target} weight`, title: `${target} weight`, disabled: !enabled,
  });
  entry.addEventListener('focus', () => entry.select());
  entry.addEventListener('click', () => entry.select());
  entry.addEventListener('change', () => {
    const text = entry.value.trim();
    const value = Number(text);
    if (text && Number.isFinite(value)) controller.setWeight(index, branch, clampWeight(value), false);
    const current = controller.config.rows[index];
    entry.value = (branch ? outputSetting(current, branch).weight : current.weight).toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1');
  });
  entry.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); entry.blur(); }
    if (event.key === 'Escape') {
      const current = controller.config.rows[index];
      entry.value = String(branch ? outputSetting(current, branch).weight : current.weight);
      entry.blur();
    }
  });
  // Read the latest value when a button is clicked after a direct edit.
  const step = direction => {
    const current = branch ? outputSetting(controller.config.rows[index], branch).weight : controller.config.rows[index].weight;
    controller.setWeight(index, branch, clampWeight(Number((current + direction * controller.prefs.step).toFixed(4))));
  };
  group.append(
    button('‹', () => step(-1), { label: `Decrease ${target} weight`, disabled: !enabled }),
    entry,
    button('›', () => step(1), { label: `Increase ${target} weight`, disabled: !enabled }),
  );
  return group;
}

function outputModule(controller, row, index, branch, removing) {
  const config = outputSetting(row, branch);
  const module = element('div', { class: `lr-module${removing ? ' lr-removing' : ''}` });
  module.append(button(branch, () => controller.toggleOutput(index, branch), {
    className: 'lr-output', label: `MODEL ${branch} ${config.on ? 'on' : 'off'}`, pressed: config.on, disabled: removing,
  }), weightEditor(controller, index, branch, config.weight, config.on && !removing));
  if (removing) module.append(button('×', () => controller.removeRoute(index, branch), {
    className: 'lr-delete lr-remove-route', label: `Remove route to MODEL ${branch}`,
  }));
  return module;
}

function routeRows(controller, row, index, branches, removing) {
  const { config, node } = controller;
  const modulesAfterPrimary = branches.filter(branch => branch > 1);
  const layout = routeLayout(modulesAfterPrimary.length, node.size[0]);
  const route = element('div', { class: `lr-route${layout.inline ? ' lr-inline' : ''}` });
  route.style.setProperty('--lr-rail-width', `${layout.rail}px`);
  route.style.setProperty('--lr-columns', layout.columns);
  const rail = element('div', { class: 'lr-rail' });
  const controls = element('div', { class: 'lr-route-controls' });
  controls.append(button('+', () => controller.addRoute(index), {
    className: 'lr-icon', label: 'Add route', disabled: nextRoute(row, config.count) === null,
  }), button('−', () => controller.toggleRemoveMode(index), {
    className: 'lr-icon', label: 'Remove routes', pressed: removing, disabled: !branches.length,
  }));
  rail.append(button('Route', () => controller.togglePerOutput(index), { className: 'lr-route-toggle', pressed: row.perOutput }), controls);
  const modules = element('div', { class: 'lr-modules' });
  for (const branch of modulesAfterPrimary) modules.append(outputModule(controller, row, index, branch, removing));
  route.append(rail, modules);
  return route;
}

function routingIcon(expanded) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', expanded ? 'M4 10 8 6l4 4' : 'M2 8h3c4 0 3-4 7-4h2m-3-2 3 2-3 2M5 8c4 0 3 4 7 4h2m-3-2 3 2-3 2');
  svg.append(path);
  return svg;
}

export function renderRows(controller) {
  const { config, prefs, root } = controller;
  const stack = element('div', { class: 'lr-stack' });
  config.rows.forEach((row, index) => {
    if (prefs.hideOff && !row.on) return;
    const block = element('div', { class: `lr-row${row.on ? '' : ' lr-off'}`, 'data-lr-row': index });
    const main = element('div', { class: 'lr-main' });
    const handle = button('⠿', null, { className: 'lr-handle', label: 'Drag to reorder · Alt + ↑ / ↓' });
    handle.addEventListener('pointerdown', event => controller.startDrag(index, event));
    handle.addEventListener('keydown', event => {
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        controller.moveRow(index, index + (event.key === 'ArrowUp' ? -1 : 1));
      }
    });
    const expanded = prefs.expanded[index] === true;
    const branches = row.perOutput ? routeBranches(row, config.count) : [];
    const removing = expanded && controller.removeModes.has(row);
    const routeButton = button('', () => controller.expandRow(index), {
      className: 'lr-icon lr-route-icon', label: expanded ? 'Close routing controls' : 'Show routing controls',
      pressed: row.perOutput ? true : undefined,
    });
    routeButton.append(routingIcon(expanded));
    routeButton.setAttribute('aria-expanded', String(Boolean(expanded)));
    const displayName = row.file.split('/').at(-1).replace(/\.[^.]+$/, '');
    const modelOne = branches.includes(1) ? outputModule(controller, row, index, 1, removing) : element('div', { class: 'lr-module lr-primary-weight' });
    if (!row.perOutput) {
      if (config.count > 1) modelOne.append(element('span', { class: 'lr-number', title: 'MODEL 1 · all outputs' }, '1'));
      modelOne.append(weightEditor(controller, index, 0, row.weight, true));
    }
    const master = button(row.on ? 'On' : 'Off', event => {
      if (event.detail === 0) controller.toggleRow(index);
    }, { className: 'lr-master', label: 'Toggle LoRA on all outputs', pressed: row.on });
    master.addEventListener('pointerdown', event => controller.startPaint(index, event));
    main.append(
      handle,
      master,
      button(displayName, () => controller.dialogs.pick(index), { className: 'lr-name', label: row.file }),
      button('i', () => controller.dialogs.info(row.file), { className: 'lr-icon', label: 'LoRA information' }),
      modelOne,
      routeButton,
      button('×', () => controller.removeRow(index), { className: 'lr-icon lr-delete', label: 'Remove LoRA' }),
    );
    block.append(main);
    if (expanded) block.append(routeRows(controller, row, index, branches, removing));
    stack.append(block);
  });
  const footer = element('div', { class: 'lr-footer' });
  footer.append(
    button('+ LoRA', () => controller.dialogs.pick()),
    button('★ Favorites', () => controller.dialogs.pick(null, 'Favorites')),
    button('Triggers', () => controller.dialogs.triggers()),
    button('Presets ▾', () => controller.dialogs.presets()),
  );
  root.replaceChildren(stack, footer);
}
