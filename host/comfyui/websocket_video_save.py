"""Sends a clip over ComfyUI's websocket, as SaveImageWebsocket does for images.

host-api reads results only from the websocket, so nothing a job makes is
written to disk. The clip is encoded in memory (H.264 MP4, with AAC audio
when it has sound), and its first frame goes first as a PNG poster. Each is
one binary message: event 1 (a preview image), a 4-byte format (2 = PNG,
16 = MP4), then the bytes. No metadata is written into either.
"""
import struct
import time
from io import BytesIO

import numpy as np
from PIL import Image
from comfy_api.latest import InputImpl, Types
from server import PromptServer

PREVIEW_IMAGE = 1
PNG = 2
MP4 = 16


class SaveVideoWebsocket:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"video": ("VIDEO",)}}

    RETURN_TYPES = ()
    FUNCTION = "save_video"
    OUTPUT_NODE = True
    CATEGORY = "video"

    def save_video(self, video):
        server = PromptServer.instance
        # A joined clip (clip_chain.py) is decoded only for its first frame.
        start = video if isinstance(video, InputImpl.VideoFromComponents) else video.as_trimmed(0, 0.5, strict_duration=False) or video
        first = start.get_components().images[0]
        poster = BytesIO()
        poster.write(struct.pack(">I", PNG))
        Image.fromarray(np.clip(255.0 * first.cpu().numpy(), 0, 255).astype(np.uint8)).save(poster, format="PNG", compress_level=1)
        server.send_sync(PREVIEW_IMAGE, poster.getvalue(), server.client_id)
        clip = BytesIO()
        video.save_to(clip, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
        server.send_sync(PREVIEW_IMAGE, struct.pack(">I", MP4) + clip.getvalue(), server.client_id)
        return {}

    @classmethod
    def IS_CHANGED(cls, video):
        return time.time()


NODE_CLASS_MAPPINGS = {"SaveVideoWebsocket": SaveVideoWebsocket}
NODE_DISPLAY_NAME_MAPPINGS = {"SaveVideoWebsocket": "Save Video (Websocket)"}
