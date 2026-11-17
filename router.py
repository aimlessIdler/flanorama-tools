"""ComfyUI execution for the LoRA Router canvas node."""

import json
import math
import os
from pathlib import PurePosixPath

import comfy.model_management
import comfy.sd
import comfy.utils
import folder_paths
from comfy_execution.graph import ExecutionBlocker

# Reserve fixed indices so changing output count or toggling CLIP preserves links.
MAX_OUTPUTS = 64
DEFAULT_CONFIG = '{"count":1,"mode":"shared","clip":false,"rows":[]}'


def canonical_filename(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError("Choose a local LoRA file.")
    name = value.replace("\\", "/")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or ":" in name or "\0" in name:
        raise ValueError("LoRA paths must be relative to a configured LoRA folder.")
    return path.as_posix()


def lora_files():
    return {canonical_filename(name): name for name in folder_paths.get_filename_list("loras")}


def resolve_lora(name, files=None):
    index = lora_files() if files is None else files
    registered_name = index.get(canonical_filename(name))
    if registered_name is None:
        raise FileNotFoundError(f"LoRA not found: {name}")
    return folder_paths.get_full_path_or_raise("loras", registered_name)


def read_weight(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("LoRA weights must be finite numbers.")
    if not -100 <= value <= 100:
        raise ValueError("LoRA weights must be between -100 and 100.")
    return float(value)


def read_config(value):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError("Invalid LoRA Router configuration.")
    count = value.get("count", 1)
    if type(count) is not int or not 1 <= count <= MAX_OUTPUTS:
        raise ValueError(f"Output count must be between 1 and {MAX_OUTPUTS}.")
    mode = value.get("mode", "shared")
    if mode not in ("shared", "separate"):
        raise ValueError("Unknown LoRA Router input mode.")
    rows = value.get("rows", [])
    if not isinstance(rows, list):
        raise ValueError("The LoRA stack must be an ordered list.")
    clean_rows = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("outputs", {}), dict):
            raise ValueError("Invalid LoRA row.")
        outputs = {}
        for number, output in row.get("outputs", {}).items():
            if (not isinstance(number, str) or number not in OUTPUT_NUMBERS
                    or not isinstance(output, dict)):
                raise ValueError("Invalid per-output LoRA weight.")
            outputs[number] = {
                "on": output.get("on") is True,
                "weight": read_weight(output.get("weight", 1)),
            }
        clean_rows.append({
            "file": canonical_filename(row.get("file")),
            "on": row.get("on", True) is True,
            "weight": read_weight(row.get("weight", 1)),
            "perOutput": row.get("perOutput") is True,
            "routeReady": row.get("routeReady") is True,
            "outputs": outputs,
        })
    return {"count": count, "mode": mode, "clip": value.get("clip") is True, "rows": clean_rows}


OUTPUT_NUMBERS = frozenset(str(index) for index in range(1, MAX_OUTPUTS + 1))


def branch_stack(config, number):
    """Resolve the ordered list of nonzero LoRA applications for a branch."""
    for row in config["rows"]:
        if not row["on"]:
            continue
        if row["perOutput"] and (config["count"] > 1 or row["routeReady"]):
            output = row["outputs"].get(str(number))
            if not output or not output["on"]:
                continue
            weight = output["weight"]
        else:
            weight = row["weight"]
        if weight:
            yield row["file"], weight


class LoRARouter:
    CATEGORY = "model/loaders"
    FUNCTION = "apply"
    DESCRIPTION = "Apply an ordered LoRA stack to independent MODEL outputs. Optional linked CLIP patches."
    RETURN_TYPES = ("MODEL", "CLIP") * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"{kind} {n}" for n in range(1, MAX_OUTPUTS + 1) for kind in ("MODEL", "CLIP"))

    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            f"{kind}_{n}": (kind.upper(),)
            for kind in ("model", "clip") for n in range(1, MAX_OUTPUTS + 1)
        }
        return {
            "required": {"config": ("STRING", {"default": DEFAULT_CONFIG})},
            "optional": inputs,
        }

    @classmethod
    def IS_CHANGED(cls, config, **_):
        config = read_config(config)
        names = {name for n in range(1, config["count"] + 1) for name, _ in branch_stack(config, n)}
        if not names:
            return ()
        files = lora_files()
        fingerprint = []
        for name in sorted(names):
            try:
                path = resolve_lora(name, files)
                stat = os.stat(path)
                fingerprint.append((name, path, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
            except FileNotFoundError:
                fingerprint.append((name, None))
        return tuple(fingerprint)

    def apply(self, config, **inputs):
        config = read_config(config)
        inactive = ExecutionBlocker("This LoRA Router output is disabled.")
        models = [inactive] * MAX_OUTPUTS
        clips = [inactive] * MAX_OUTPUTS
        files = None
        tensors = {}
        branches = {}

        for number in range(1, config["count"] + 1):
            source = 1 if config["mode"] == "shared" else number
            model = inputs.get(f"model_{source}")
            clip = inputs.get(f"clip_{source}") if config["clip"] else None
            if model is None:
                models[number - 1] = ExecutionBlocker(f"Connect MODEL {source} on LoRA Router.")
                if config["clip"]:
                    clips[number - 1] = models[number - 1]
                continue

            stack = tuple(branch_stack(config, number))
            key = (id(model), id(clip), stack)
            if key not in branches:
                patched_model, patched_clip = model, clip
                for name, weight in stack:
                    comfy.model_management.throw_exception_if_processing_interrupted()
                    if name not in tensors:
                        if files is None:
                            files = lora_files()
                        path = resolve_lora(name, files)
                        tensors[name] = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
                    weights, metadata = tensors[name]
                    patched_model, patched_clip = comfy.sd.load_lora_for_models(
                        patched_model, patched_clip, weights, weight,
                        weight if patched_clip is not None else 0,
                        lora_metadata=metadata,
                    )
                branches[key] = patched_model, patched_clip
            models[number - 1], patched_clip = branches[key]
            if config["clip"]:
                clips[number - 1] = patched_clip if patched_clip is not None else ExecutionBlocker(
                    f"Connect CLIP {source} on LoRA Router to use CLIP {number}."
                )
        return tuple(value for pair in zip(models, clips) for value in pair)
