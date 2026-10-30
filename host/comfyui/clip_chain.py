"""Chaining clips into one longer clip.

A continuation workflow makes the next clip of a long video from the clip
so far: LyricaClipTail gives the clip's last frames and their sound, which
anchor the start of the new clip (MiniMaxH3AddGuide), and LyricaJoinClips
drops the new clip's first `overlap` frames, which repeat that tail, and
appends the rest. The clip so far is never decoded whole: the tail decodes
only its last second or so, and the joined clip is encoded one segment at a
time (ComfyUI's VideoFromList).
"""
import io
from fractions import Fraction

from comfy_api.latest import InputImpl, Types


class ClipTail:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO",),
            "frames": ("INT", {"default": 22, "min": 1, "max": 1024}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    FUNCTION = "tail"
    CATEGORY = "video"

    def tail(self, video, frames):
        rate = float(video.get_frame_rate())
        seconds = video.get_duration()
        # A few spare frames, so a frame time that rounds either way still gives `frames`.
        start = max(0.0, seconds - (frames + 4) / rate)
        parts = (video.as_trimmed(start, seconds - start, strict_duration=False) or video).get_components()
        images = parts.images[-frames:]
        audio = parts.audio
        if audio is not None:
            rate_hz = int(audio["sample_rate"])
            keep = round(images.shape[0] / rate * rate_hz)
            audio = {"waveform": audio["waveform"][..., -keep:], "sample_rate": rate_hz}
        else:
            audio = None
        return (images, audio)


class JoinClips:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "previous": ("VIDEO",),
                "images": ("IMAGE",),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0}),
                "overlap": ("INT", {"default": 22, "min": 0, "max": 1024}),
            },
            "optional": {"audio": ("AUDIO",)},
        }

    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "join"
    CATEGORY = "video"

    def join(self, previous, images, fps, overlap, audio=None):
        rest = images[overlap:]
        if audio is not None:
            rate_hz = int(audio["sample_rate"])
            audio = {"waveform": audio["waveform"][..., round(overlap / fps * rate_hz):], "sample_rate": rate_hz}
        added = InputImpl.VideoFromComponents(Types.VideoComponents(images=rest, audio=audio, frame_rate=Fraction(fps).limit_denominator(1000)))
        # Encoded as MP4 here: VideoFromList would hold it as MKV, whose millisecond timestamps (41 or 42 ms for
        # 1/24 s) came through its remux unchanged, so the joined clips played at about 23.8 and 24.4 fps.
        buffer = io.BytesIO()
        added.save_to(buffer, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
        buffer.seek(0)
        return (InputImpl.VideoFromList([previous, InputImpl.VideoFromFile(buffer)]),)


NODE_CLASS_MAPPINGS = {"LyricaClipTail": ClipTail, "LyricaJoinClips": JoinClips}
NODE_DISPLAY_NAME_MAPPINGS = {"LyricaClipTail": "Clip Tail", "LyricaJoinClips": "Join Clips"}
