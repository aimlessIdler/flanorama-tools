"""Flanorama Tools for ComfyUI."""

from .frame_select import FrameSelectNode
from .library import register_routes
from .markdown_note import MarkdownNote
from .prompt_history import PromptHistoryText
from .router import LoRARouter
from .sampler_scheduler_select import SimpleSamplerConfig
from .startup import print_startup_banner
from .variable_toggle_node import VariableToggle

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "CompactLoRARouter": LoRARouter,
    "FrameSelectNode": FrameSelectNode,
    "PromptHistoryText": PromptHistoryText,
    "FlaMarkdownNote": MarkdownNote,
    "SimpleSamplerConfig": SimpleSamplerConfig,
    "VariableToggle": VariableToggle,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CompactLoRARouter": "LoRA Router",
    "FrameSelectNode": "Frame Select (Scene Stitch)",
    "PromptHistoryText": "Prompt History",
    "FlaMarkdownNote": "Markdown Note (Flanorama)",
    "SimpleSamplerConfig": "Simple Sampler & Scheduler",
    "VariableToggle": "Variable Toggle",
}

register_routes()
print_startup_banner(len(NODE_CLASS_MAPPINGS))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
