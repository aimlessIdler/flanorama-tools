"""Render the Flanorama logo and release details in the startup terminal."""

import os
from pathlib import Path
import re
import shutil
import sys


ROOT = Path(__file__).resolve().parent
REPOSITORY = "https://github.com/aimlessIdler/flanorama-tools"
RESET = "\x1b[0m"
SGR = re.compile(r"\x1b\[[0-9;]*m")
YELLOW = "230;178;16"
GRAY = "78;93;99"
TEAL = "59;208;192"
OFF_WHITE = "232;230;225"
GUTTER = "    "


def _release_version():
    metadata = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', metadata, re.MULTILINE)
    return f"v{match[1]} " if match else ""


def _color(text, rgb, *, italic=False):
    style = "3;" if italic else ""
    return f"\x1b[{style}38;2;{rgb}m{text}{RESET}"


def _format_banner(logo, status, columns):
    logo_width = max(len(SGR.sub("", row)) for row in logo)
    labels = [
        _color("F L A N O R A M A", YELLOW),
        _color("Custom nodes for ComfyUI", GRAY),
        "",
        _color("The only way forward is to drift", TEAL, italic=True),
        _color("- Aimless Idler", GRAY),
        "",
        _color(status, OFF_WHITE),
        "",
        _color(REPOSITORY, GRAY),
    ]
    label_width = max(len(SGR.sub("", row)) for row in labels)
    if logo_width + len(GUTTER) + label_width >= columns:
        return "\n".join([*logo, "", *labels])

    top = (len(logo) - len(labels)) // 2
    rows = []
    for index, row in enumerate(logo):
        label = labels[index - top] if top <= index < top + len(labels) else ""
        padding = " " * (logo_width - len(SGR.sub("", row)))
        rows.append(f"{row}{RESET}{padding}{GUTTER}{label}" if label else row)
    return "\n".join(rows)


def print_startup_banner(node_count):
    stream = sys.stdout
    if stream is None:
        return
    try:
        version = _release_version()
    except (OSError, UnicodeError):
        version = ""
    status = f"{version}......... {node_count} nodes"
    fallback = f"Flanorama Tools {status}  {REPOSITORY}"
    # ComfyUI launchers often pipe stdout through a terminal log viewer.
    if os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        print(fallback, file=stream, flush=True)
        return

    try:
        logo = (ROOT / "flanorama.ans").read_text(encoding="utf-8").splitlines()
        columns = shutil.get_terminal_size(fallback=(100, 24)).columns
        banner = _format_banner(logo, status, columns)
    except (OSError, UnicodeError, ValueError):
        print(fallback, file=stream, flush=True)
    else:
        output = f"\n{banner}{RESET}\n"
        try:
            output.encode(stream.encoding or "utf-8")
        except UnicodeEncodeError:
            # Windows launchers may report a legacy pipe encoding even though
            # their terminal viewer accepts UTF-8.
            buffer = getattr(stream, "buffer", None)
            if buffer is None:
                print(fallback, file=stream, flush=True)
            else:
                stream.flush()
                buffer.write(output.encode("utf-8"))
                buffer.flush()
        else:
            print(output, file=stream, flush=True)
