export const MAX_OUTPUTS = 64;
export const NODE_TYPE = 'CompactLoRARouter';
export const DEFAULT_STEP = 0.05;

const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export const clampWeight = value => Math.max(-100, Math.min(100, value));

export function parseConfig(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { value = {}; }
  }
  const rows = Array.isArray(value?.rows) ? value.rows : [];
  const count = Math.max(1, Math.min(MAX_OUTPUTS, Math.trunc(number(value?.count, 1))));
  return {
    count,
    mode: value?.mode === 'separate' ? 'separate' : 'shared',
    clip: value?.clip === true,
    rows: rows.filter(row => typeof row?.file === 'string' && row.file).map(row => ({
      file: row.file.replaceAll('\\', '/'),
      on: row.on !== false,
      weight: clampWeight(number(row.weight, 1)),
      perOutput: row.perOutput === true && (count > 1 || row.routeReady === true),
      routeReady: row.routeReady === true || row.perOutput === true || Object.keys(row.outputs ?? {}).length > 0,
      outputs: Object.fromEntries(Object.entries(row.outputs ?? {}).filter(([key, output]) =>
        /^[1-9]\d*$/.test(key) && Number(key) <= MAX_OUTPUTS && output && typeof output === 'object'
      ).map(([key, output]) => [key, { on: output.on === true, weight: clampWeight(number(output.weight, 1)) }])),
    })),
  };
}

export function editorPrefs(value) {
  return {
    portsOpen: value?.portsOpen === true,
    hideOff: value?.hideOff === true,
    step: Math.max(0.0001, Math.min(100, number(value?.step, DEFAULT_STEP))),
    sources: { com: value?.sources?.com !== false, red: value?.sources?.red !== false },
    expanded: Array.isArray(value?.expanded) ? value.expanded.map(Boolean) : [],
  };
}

export function newRow(file) {
  return { file, on: true, weight: 1, perOutput: false, routeReady: false, outputs: {} };
}

export function outputSetting(row, branch) {
  return row.outputs[branch] ?? { on: false, weight: row.weight };
}

export function enablePerOutput(row, count) {
  if (!row.routeReady) {
    for (let branch = 1; branch <= count; branch++) row.outputs[branch] = { on: true, weight: row.weight };
    row.routeReady = true;
  }
  row.perOutput = true;
}

export function routeBranches(row, count) {
  return Object.keys(row.outputs).map(Number).filter(branch => branch <= count).sort((a, b) => a - b);
}

export function nextRoute(row, count) {
  // A fresh row starts with MODEL 1. Existing rows can have a gap at any output.
  for (let branch = row.routeReady ? 1 : 2; branch <= count; branch++) {
    if (!Object.hasOwn(row.outputs, branch)) return branch;
  }
  return count < MAX_OUTPUTS ? count + 1 : null;
}

export function activeFiles(config, branch) {
  return [...new Set(config.rows.filter(row => {
    if (!row.on) return false;
    if (!row.perOutput) return row.weight !== 0;
    const output = outputSetting(row, branch);
    return output.on && output.weight !== 0;
  }).map(row => row.file))];
}

export function outputBranch(slot) {
  return Math.floor(slot / 2) + 1;
}
