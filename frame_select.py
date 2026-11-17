"""Pick the boundary frame between two clips."""

import base64
from dataclasses import dataclass, field
from io import BytesIO
from threading import Event, Lock
from time import monotonic
from uuid import uuid4

from aiohttp import web
from PIL import Image

from comfy import model_management
from server import PromptServer


REVIEW_TIMEOUT = 300


@dataclass
class Review:
    frames: dict
    ready: Event = field(default_factory=Event)
    index: int | None = None


_reviews = {}
_reviews_lock = Lock()


@PromptServer.instance.routes.get("/flanodes/frame-review/{token}")
async def frame_data(request):
    with _reviews_lock:
        review = _reviews.get(request.match_info["token"])
    if review is None:
        return web.json_response({"error": "Frame review ended."}, status=404)
    return web.json_response(review.frames, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.post("/flanodes/frame-review/{token}")
async def select_frame(request):
    try:
        data = await request.json()
        index = data["index"]
    except (ValueError, KeyError, TypeError):
        return web.json_response({"error": "Invalid selection."}, status=400)
    with _reviews_lock:
        review = _reviews.get(request.match_info["token"])
        if review is None or review.ready.is_set():
            return web.json_response({"error": "Frame review ended."}, status=404)
        if index is not None and (
            type(index) is not int or not 0 <= index < len(review.frames["frames"])
        ):
            return web.json_response({"error": "Frame is outside the review range."}, status=400)
        review.index = index
        review.ready.set()
    return web.json_response({"selected": index})


def _preview(frame):
    pixels = frame.detach().float().cpu().clamp(0, 1).mul(255).byte().numpy()
    if pixels.shape[-1] == 1:
        pixels = pixels[..., 0]
    image = Image.fromarray(pixels).convert("RGB")
    image.thumbnail((960, 960), Image.Resampling.LANCZOS)
    with BytesIO() as buffer:
        image.save(buffer, format="JPEG", quality=82)
        return base64.b64encode(buffer.getvalue()).decode("ascii")


def _review_index(images, review_frames, scene_name, next_scene_name):
    server = PromptServer.instance
    client = server.client_id
    if not client or client not in server.sockets:
        raise ValueError("Frame review needs a connected browser. For API jobs, choose Exact frame or Last frame.")
    start_index = max(0, len(images) - review_frames)
    previews = []
    for frame in images[start_index:]:
        model_management.throw_exception_if_processing_interrupted()
        previews.append(_preview(frame))
    review = Review({
        "frames": previews,
        "start_index": start_index,
        "batch_size": len(images),
        "scene_name": scene_name,
        "next_scene_name": next_scene_name,
    })
    token = uuid4().hex
    with _reviews_lock:
        _reviews[token] = review
    try:
        server.send_sync("flanodes.review_opened", {"token": token}, client)
        deadline = monotonic() + REVIEW_TIMEOUT
        while not review.ready.wait(0.25):
            model_management.throw_exception_if_processing_interrupted()
            if monotonic() >= deadline:
                raise TimeoutError("Frame review expired after five minutes.")
        model_management.throw_exception_if_processing_interrupted()
        if review.index is None:
            raise model_management.InterruptProcessingException()
        return start_index + review.index
    finally:
        with _reviews_lock:
            _reviews.pop(token, None)
        server.send_sync("flanodes.review_closed", {"token": token}, client)


class FrameSelectNode:
    """Return the handoff frame and the preceding frames of the current clip."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "review_frames": ("INT", {"default": 16, "min": 1, "max": 120}),
                "scene_name": ("STRING", {"default": "Scene_01", "tooltip": "Current scene label in the review dialog."}),
                "next_scene_name": ("STRING", {"default": "Scene_02", "tooltip": "Next scene label in the review dialog."}),
                "enable_looping": ("BOOLEAN", {"default": False, "tooltip": "Legacy workflow field. Use the selected frame to wire your own scene loop."}),
            },
            "optional": {
                "selection_mode": (["Review in browser", "Exact frame", "Last frame"], {"default": "Review in browser"}),
                "frame_number": ("INT", {"default": 1, "min": 1, "max": 2147483647, "tooltip": "One-based frame number for Exact frame mode."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("selected_frame", "truncated_batch")
    FUNCTION = "review_and_select"
    CATEGORY = "Flanorama Tools/video"
    OUTPUT_NODE = True
    DESCRIPTION = "Choose a frame to start the next scene and trim the current clip at that boundary."

    @classmethod
    def IS_CHANGED(cls, images=None, selection_mode="Review in browser", **kwargs):
        if selection_mode == "Review in browser":
            return float("nan")
        return selection_mode

    def review_and_select(
        self, images, review_frames, scene_name, next_scene_name, enable_looping,
        selection_mode="Review in browser", frame_number=1,
    ):
        if len(images) == 0:
            raise ValueError("Frame Select requires at least one image.")
        if selection_mode == "Exact frame":
            if not 1 <= frame_number <= len(images):
                raise ValueError(f"Frame number must be between 1 and {len(images)}.")
            index = frame_number - 1
        elif selection_mode == "Last frame":
            index = len(images) - 1
        else:
            index = _review_index(images, review_frames, scene_name, next_scene_name)
        return images[index:index + 1], images[:max(1, index)]
