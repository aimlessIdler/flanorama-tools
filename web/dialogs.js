import { api } from '../../scripts/api.js';
import { activeFiles, MAX_OUTPUTS, parseConfig } from './state.js';
import { button, element } from './rows.js';

async function request(route, payload, signal) {
  const options = { signal };
  if (payload !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload);
  }
  const response = await api.fetchApi(`/lora-router/${route}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

const actions = (...children) => {
  const row = element('div', { class: 'lr-actions' });
  row.append(...children);
  return row;
};

function field(label, control, checkbox = false) {
  const result = element('label', { class: checkbox ? 'lr-check' : 'lr-field' });
  if (checkbox) result.append(control, label);
  else result.append(label, control);
  return result;
}

function select(entries, current) {
  const control = element('select');
  for (const [value, label] of entries) control.append(element('option', { value }, label));
  if (current !== undefined) control.value = current;
  return control;
}

function plainDescription(value) {
  if (typeof value !== 'string') return '';
  // Parse in an inert template and copy plain text into the dialog.
  const template = document.createElement('template');
  template.innerHTML = value;
  template.content.querySelectorAll('script,style').forEach(node => node.remove());
  return template.content.textContent.trim();
}

function promptTargets(graph) {
  const targets = [];
  for (const node of graph?.nodes ?? graph?._nodes ?? []) {
    const type = node.comfyClass || node.type || '';
    if (!/text\s*encode|prompt/i.test(type)) continue;
    for (const widget of node.widgets ?? []) {
      if (typeof widget.value !== 'string' || widget.hidden || widget.disabled || widget.computedDisabled) continue;
      if (!/^(text|text_g|text_l|clip_l|t5xxl|prompt|positive|negative)(_|$)/i.test(widget.name)) continue;
      const input = node.inputs?.find(slot => slot.name === widget.name);
      if (input?.isConnected || input?.link != null) continue;
      targets.push({ node, widget, label: `${node.title || type} #${node.id} · ${widget.name}` });
    }
  }
  return targets;
}

function appendTriggers(target, phrases) {
  const { node, widget } = target;
  if (!node.graph || !node.widgets?.includes(widget)) throw new Error('The target prompt was removed.');
  const oldValue = widget.value;
  const existing = oldValue.split(',').map(word => word.trim());
  const additions = phrases.filter(phrase => {
    const parts = phrase.split(',').map(word => word.trim());
    return !existing.some((_, index) => parts.every((part, offset) => existing[index + offset] === part));
  });
  if (!additions.length) return false;
  const next = [oldValue.trimEnd().replace(/,+$/, ''), ...additions].filter(Boolean).join(', ');
  node.graph.beforeChange();
  try {
    widget.value = next;
    if (widget.inputEl && widget.inputEl.value !== next) widget.inputEl.value = next;
    widget.callback?.(next);
    node.onWidgetChanged?.(widget.name, next, oldValue, widget);
    node.graph.incrementVersion?.();
    node.setDirtyCanvas(true, true);
  } finally {
    node.graph.afterChange(node);
  }
  return true;
}

export class Dialogs {
  constructor(controller) {
    this.controller = controller;
    this.current = null;
  }

  close() { this.current?.close(); }

  open(title) {
    this.close();
    const abort = new AbortController();
    const dialog = element('dialog', { class: 'lora-router lr-dialog', 'aria-label': title });
    const close = () => {
      abort.abort();
      dialog.remove();
      if (this.current === context) this.current = null;
    };
    const header = element('div', { class: 'lr-dialog-title' });
    header.append(element('strong', {}, title), button('×', close, { className: 'lr-icon', label: 'Close' }));
    const body = element('div');
    const status = element('div', { class: 'lr-hint', role: 'status' });
    dialog.append(header, body, status);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    document.body.append(dialog);
    const context = { body, status, close, signal: abort.signal };
    this.current = context;
    dialog.showModal();
    return context;
  }

  async run(dialog, task) {
    try { await task(); }
    catch (error) {
      if (!dialog.signal.aborted) dialog.status.textContent = error.message || 'Request failed.';
    }
  }

  settings() {
    const { controller } = this;
    const { config, prefs } = controller;
    const dialog = this.open('LoRA Router settings');
    const form = element('form');
    const fields = element('div', { class: 'lr-fields' });
    const count = element('input', { type: 'number', min: 1, max: MAX_OUTPUTS, step: 1, value: config.count, required: true });
    const step = element('input', { type: 'number', min: 0.0001, max: 100, step: 'any', value: prefs.step, required: true });
    const mode = select([['shared', 'Shared base'], ['separate', 'Per-output bases']], config.mode);
    const clip = element('input', { type: 'checkbox', checked: config.clip });
    const com = element('input', { type: 'checkbox', checked: prefs.sources.com });
    const red = element('input', { type: 'checkbox', checked: prefs.sources.red });
    fields.append(field('Output count', count), field('Weight increment', step), field('Input mode', mode),
      field('CLIP inputs and outputs', clip, true), field('civitai.com / civit.ai', com, true), field('civitai.red', red, true));
    form.append(fields, actions(element('button', { type: 'submit' }, 'Apply')));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const error = controller.configurePorts({ count: count.valueAsNumber, mode: mode.value, clip: clip.checked }, {
        step: step.valueAsNumber, sources: { com: com.checked, red: red.checked },
      });
      if (error) dialog.status.textContent = error;
      else dialog.close();
    });
    dialog.body.append(form);
  }

  pick(index = null, tab = 'All') {
    const dialog = this.open(index === null ? 'Add LoRAs' : 'Replace LoRA');
    dialog.status.textContent = 'Loading local LoRAs…';
    return this.run(dialog, async () => {
      const [{ files }, initialLibrary] = await Promise.all([
        request('files', undefined, dialog.signal), request('library', undefined, dialog.signal),
      ]);
      if (dialog.signal.aborted) return;
      let library = initialLibrary;
      const selected = new Set();
      const search = element('input', { type: 'search', class: 'lr-search', placeholder: 'Search filename or folder…', 'aria-label': 'Search local LoRAs' });
      const tabs = actions();
      const list = element('div', { class: 'lr-file-list' });
      const apply = button('Add selected', () => choose([...selected]), { disabled: true });
      const footer = actions(apply);
      const choose = names => {
        if (!names.length) return;
        if (index === null) this.controller.addRows(names);
        else this.controller.replaceRow(index, names[0]);
        dialog.close();
        // Updating recents is independent of the graph edit.
        request('library', { action: 'used', files: names }).catch(error => this.controller.notice(error.message));
      };
      const draw = () => {
        const query = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        const visible = files.filter(file => {
          if (tab === 'Favorites' && !library.favorites.includes(file)) return false;
          if ((tab === 'Recent' || tab === 'Most used') && !library.usage[file]) return false;
          return query.every(word => file.toLowerCase().includes(word));
        });
        if (tab === 'Recent') visible.sort((a, b) => library.usage[b].last.localeCompare(library.usage[a].last));
        if (tab === 'Most used') visible.sort((a, b) => library.usage[b].count - library.usage[a].count);
        tabs.replaceChildren(...['All', 'Favorites', 'Recent', 'Most used'].map(label => button(label, () => { tab = label; draw(); }, { pressed: tab === label })));
        list.replaceChildren(...visible.slice(0, 300).map(file => {
          const row = element('div', { class: 'lr-choice' });
          const load = button(file, () => choose([file]), { label: `Load ${file}` });
          if (index === null) {
            const check = element('input', { type: 'checkbox', checked: selected.has(file), 'aria-label': `Select ${file}` });
            check.addEventListener('change', () => {
              if (check.checked) selected.add(file);
              else selected.delete(file);
              apply.disabled = selected.size === 0;
              apply.textContent = selected.size ? `Add ${selected.size} selected` : 'Add selected';
            });
            const group = element('label');
            group.append(check, load);
            row.append(group);
          } else row.append(load);
          const favorite = button(library.favorites.includes(file) ? '★' : '☆', () => this.run(dialog, async () => {
            favorite.disabled = true;
            try {
              library = await request('library', { action: 'favorite', files: [file] }, dialog.signal);
              if (!dialog.signal.aborted) draw();
            } finally { favorite.disabled = false; }
          }), { label: 'Toggle favorite' });
          row.append(favorite);
          return row;
        }));
        dialog.status.textContent = visible.length > 300 ? `Showing 300 of ${visible.length}. Search to narrow the list.` : visible.length ? '' : 'No matching LoRAs.';
      };
      search.addEventListener('input', draw);
      dialog.body.append(search, tabs, list);
      if (index === null) dialog.body.append(footer);
      draw();
      search.focus();
    });
  }

  info(file) {
    const dialog = this.open(file.split('/').at(-1));
    const sources = Object.keys(this.controller.prefs.sources).filter(source => this.controller.prefs.sources[source]);
    const load = refresh => this.run(dialog, async () => {
      dialog.status.textContent = 'Checking LoRA metadata…';
      const result = await request('metadata', { file, sources, lookup: true, refresh }, dialog.signal);
      if (dialog.signal.aborted) return;
      const groups = [];
      for (const source of new Set([...sources, ...Object.keys(result.records)])) {
        const host = source === 'red' ? 'civitai.red' : 'civitai.com';
        const record = result.records[source];
        const section = element('div', { class: 'lr-info-section' });
        section.append(element('strong', {}, `${host} · ${result.status[source] || 'Cached'}`));
        if (record) {
          const page = element('a', { href: record.page, target: '_blank', rel: 'noopener noreferrer' }, record.name || 'Open model page');
          const details = [record.version, record.baseModel, record.creator].filter(Boolean).join(' · ');
          section.append(actions(page), element('div', { class: 'lr-hint' }, details));
          const description = plainDescription(record.description);
          if (description) section.append(element('p', { class: 'lr-description' }, description));
          const words = [...new Set([record, ...(record.history ?? [])].flatMap(item => item.trainedWords))];
          if (words.length) section.append(element('div', { class: 'lr-hint' }, 'Documented triggers'), actions(...words.map(word => button(word, () => this.triggers({ file, selected: [word] })))));
          else section.append(element('div', { class: 'lr-hint' }, 'No documented triggers.'));
        }
        groups.push(section);
      }
      dialog.body.replaceChildren(...groups, actions(button('Recall triggers', () => this.triggers({ file })), button('Refresh', () => load(true), { disabled: !sources.length })));
      dialog.status.textContent = '';
    });
    return load(false);
  }

  triggers(options = {}) {
    const dialog = this.open('Saved LoRA triggers');
    const { controller } = this;
    const config = controller.config;
    const targets = promptTargets(controller.node.graph);
    const output = select(Array.from({ length: config.count }, (_, index) => [index + 1, `MODEL ${index + 1}`]));
    const target = select([['', 'Choose prompt field…'], ...targets.map((item, index) => [index, item.label])]);
    const fields = element('div', { class: 'lr-fields' });
    if (!options.file) fields.append(field('Output', output));
    fields.append(field('Insert into', target));
    const list = element('div');
    let selected = new Set(options.selected ?? []);
    let available = new Set();
    const append = button('Append selected', () => this.run(dialog, async () => {
      dialog.status.textContent = appendTriggers(targets[Number(target.value)], [...selected]) ? 'Triggers appended.' : 'These triggers are already in the prompt.';
    }), { disabled: true });
    const copy = button('Copy selected', () => this.run(dialog, async () => {
      const text = [...selected].join(', ');
      try {
        await navigator.clipboard.writeText(text);
        dialog.status.textContent = 'Triggers copied.';
      } catch {
        const manual = element('input', { type: 'text', readonly: true, value: text, 'aria-label': 'Selected trigger text' });
        dialog.status.replaceChildren(manual);
        manual.focus();
        manual.select();
      }
    }), { disabled: true });
    const controls = () => { append.disabled = !selected.size || target.value === ''; copy.disabled = !selected.size; };
    target.addEventListener('change', controls);
    dialog.body.append(fields, list, actions(append, copy));
    let requestId = 0;
    const load = () => this.run(dialog, async () => {
      const id = ++requestId;
      selected = new Set(options.selected ?? []);
      available = new Set();
      list.replaceChildren();
      append.disabled = copy.disabled = true;
      const files = options.file ? [options.file] : activeFiles(config, Number(output.value));
      if (!files.length) { dialog.status.textContent = 'No active LoRAs on this output.'; return; }
      dialog.status.textContent = 'Reading saved triggers…';
      const { triggers } = await request('triggers', { files }, dialog.signal);
      if (id !== requestId || dialog.signal.aborted) return;
      const chips = new Map();
      for (const [file, sources] of Object.entries(triggers)) {
        const words = [...new Set(Object.values(sources).flat())];
        if (!words.length) continue;
        const row = element('div', { class: 'lr-info-section' });
        row.append(element('strong', {}, file.split('/').at(-1)));
        row.append(actions(...words.map(word => {
          available.add(word);
          const chip = button(word, () => {
            if (selected.has(word)) selected.delete(word);
            else selected.add(word);
            for (const match of chips.get(word)) match.setAttribute('aria-pressed', String(selected.has(word)));
            controls();
          }, { pressed: selected.has(word) });
          if (!chips.has(word)) chips.set(word, []);
          chips.get(word).push(chip);
          return chip;
        })));
        list.append(row);
      }
      selected = new Set([...selected].filter(word => available.has(word)));
      dialog.status.textContent = available.size ? '' : 'Open a LoRA’s information panel to retrieve its triggers.';
      controls();
    });
    output.addEventListener('change', load);
    return load();
  }

  presets() {
    const dialog = this.open('LoRA presets');
    return this.run(dialog, async () => {
      let library = await request('library', undefined, dialog.signal);
      if (dialog.signal.aborted) return;
      const name = element('input', { type: 'text', maxlength: 100, placeholder: 'Preset name' });
      const list = element('div', { class: 'lr-file-list' });
      const draw = () => list.replaceChildren(...Object.entries(library.presets).sort(([a], [b]) => a.localeCompare(b)).map(([key, config]) => {
        const row = element('div', { class: 'lr-choice' });
        row.append(element('span', {}, key), button('Replace', () => apply(config, false)), button('Append', () => apply(config, true)),
          button('×', () => this.run(dialog, async () => {
            if (!window.confirm(`Delete preset “${key}”?`)) return;
            library = await request('library', { action: 'delete', name: key }, dialog.signal);
            if (!dialog.signal.aborted) draw();
          }), { label: 'Delete preset', className: 'lr-icon lr-delete' }));
        return row;
      }));
      const apply = (data, append) => {
        const config = parseConfig(data);
        this.controller.applyPreset(config.rows, append);
        dialog.close();
      };
      const save = button('Save stack', () => this.run(dialog, async () => {
        const key = name.value.trim();
        if (!key) { dialog.status.textContent = 'Enter a preset name.'; return; }
        const replace = Object.hasOwn(library.presets, key);
        if (replace && !window.confirm(`Replace preset “${key}”?`)) return;
        library = await request('library', { action: 'save', name: key, replace, config: this.controller.config }, dialog.signal);
        if (!dialog.signal.aborted) { draw(); dialog.status.textContent = `Saved ${key}.`; }
      }));
      dialog.body.append(field('Name', name), actions(save), list);
      draw();
    });
  }
}
