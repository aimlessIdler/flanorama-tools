import { DEFAULTS, normalizeOptions } from "./packing.js";

const KEY = "comfyui.pill-packer.v1";
export const BUILTIN_PRESETS = {
  "Type stacks": { ...DEFAULTS },
  "Screenshot style": { ...DEFAULTS, color: "type", grouping: "single" },
  "One compact stack": { ...DEFAULTS, layout: "stack", width: "fit", gapY: 0 },
  "Uniform columns": { ...DEFAULTS, layout: "columns", width: "selection" },
};

export function loadState(storage = globalThis.localStorage) {
  try {
    const data = JSON.parse(storage.getItem(KEY) || "{}");
    const presets = {};
    if (data?.presets && typeof data.presets === "object") {
      for (const [name, options] of Object.entries(data.presets).slice(0, 40)) {
        if (name && name !== "__proto__" && name !== "constructor") presets[name.slice(0,60)] = normalizeOptions(options);
      }
    }
    return { options: normalizeOptions(data?.options), presets };
  } catch { return { options: { ...DEFAULTS }, presets: {} }; }
}
export function saveState(state, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(state)); return true; }
  catch { return false; }
}
