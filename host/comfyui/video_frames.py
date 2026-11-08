"""A driving clip's frames at the model's frame rate.

A pose-driven model (SCAIL-2) moves a reference image as the person in a
driving clip moves, frame for frame, at its own rate (16 fps for Wan). A
phone clip is 30 or 60 fps, so this decodes only the start the clip needs
and picks the nearest source frame for each output frame: the moves keep
their real speed. host-api has already capped `frames` to the clip's length;
rounding past its end repeats the last frame.

A clip to edit (LyricaSourceFrames) is read the same way, with the sound
of the frames it keeps, so the edit can keep the clip's own soundtrack.
"""


def _start(video, fps, frames):
    """The clip's first `frames` frames at `fps`, and the decoded start they came from."""
    # One spare source frame, so rounding never runs past what was decoded.
    start = video.as_trimmed(0, frames / fps + 1 / fps, strict_duration=False) or video
    parts = start.get_components()
    images, rate = parts.images, float(parts.frame_rate) or fps
    last = images.shape[0] - 1
    picks = [min(last, round(i * rate / fps)) for i in range(frames)]
    return images[picks], parts


class DrivingFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO",),
            "fps": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 120.0}),
            "frames": ("INT", {"default": 81, "min": 1, "max": 4096}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "frames"
    CATEGORY = "video"

    def frames(self, video, fps, frames):
        return (_start(video, fps, frames)[0],)


class SourceFrames(DrivingFrames):
    RETURN_TYPES = ("IMAGE", "AUDIO")

    def frames(self, video, fps, frames):
        images, parts = _start(video, fps, frames)
        audio = parts.audio
        if audio is not None:
            rate_hz = int(audio["sample_rate"])
            audio = {"waveform": audio["waveform"][..., :round(frames / fps * rate_hz)], "sample_rate": rate_hz}
        return (images, audio)


NODE_CLASS_MAPPINGS = {"LyricaDrivingFrames": DrivingFrames, "LyricaSourceFrames": SourceFrames}
NODE_DISPLAY_NAME_MAPPINGS = {"LyricaDrivingFrames": "Driving Frames", "LyricaSourceFrames": "Source Frames"}
