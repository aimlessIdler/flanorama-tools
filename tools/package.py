"""Build a ZIP containing only the files needed by ComfyUI users."""

from pathlib import Path
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
folder_name = metadata["tool"]["comfy"]["DisplayName"].replace(" ", "-")
output = root / "dist" / f"{folder_name}-{metadata['project']['version']}.zip"
output.parent.mkdir(exist_ok=True)
files = [
    root / name
    for name in ("README.md", "LICENSE", "pyproject.toml", "requirements.txt", "flanorama.ans")
]
files += list(root.glob("*.py"))
files += list((root / "docs").glob("*.md"))
files += [file for file in (root / "web").iterdir() if file.suffix in (".js", ".css")]

with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for file in sorted(files):
        archive.write(file, Path(folder_name) / file.relative_to(root))
print(output)
