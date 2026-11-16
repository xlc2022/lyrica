#!/usr/bin/env python3
"""Lyrica's Qwen3-TTS speech server: Qwen3-TTS voice models through
faster-qwen3-tts (PyTorch with CUDA graphs), one model per GPU.

It speaks the same small API as the Kokoro speech server (host/speech/), so
host-api drives both alike. Only host-api talks to it, on the models network,
which has no route out. It logs nothing and writes nothing: the models folder
is read-only, and the only writable place is /tmp, a tmpfs. Text it is asked
to read is never kept.

- POST /load   {"name", "folder", "device": <GPU index>}
  A CustomVoice model's voices are its speakers; a Base model's are the clips
  in VOICES_DIR (<name>.wav with its transcript in <name>.txt), which it
  clones. A load captures the CUDA graphs with two warm-up sentences.
- POST /unload {"name"}
- POST /reset  {}
  Once nothing is loaded, a server that has used a GPU exits after answering,
  and Docker starts it again: PyTorch keeps its CUDA context for as long as
  the process lives, so this is how a paused or idle host frees the GPU.
- POST /v1/audio/speech {"model", "input", "voice", "speed"}: 16-bit mono PCM
  at 24 kHz, streamed as it is made. Qwen3-TTS has no speed input, so the
  audio is stretched to the speed without changing its pitch.
- GET  /health
"""
import json
import os
import queue
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

RATE = 24000
PORT = int(os.environ.get("SPEECH_PORT", "8000"))
MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
VOICES_DIR = os.environ.get("VOICES_DIR", "/opt/speech/voices")
CHUNK = 8  # decoder steps per streamed chunk: about 0.67 s of audio
HAN = re.compile(r"[㐀-鿿豈-﫿]")
WARM_UP = ("Hello there, this is a warm-up sentence.", "你好，这是一句用来预热的话。")


class Refused(Exception):
    """A request this server won't serve: a plain sentence for host-api, never the text."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def builtin_voices():
    """The clips a Base model clones, by name: (path, transcript)."""
    out = {}
    try:
        names = sorted(os.listdir(VOICES_DIR))
    except OSError:
        return out
    for f in names:
        if f.endswith(".wav") and f[:-4] + ".txt" in names:
            with open(os.path.join(VOICES_DIR, f[:-4] + ".txt"), encoding="utf-8") as t:
                out[f[:-4]] = (os.path.join(VOICES_DIR, f), t.read().strip())
    return out


def frame_limit(text):
    """At most four times the frames the text should take, so a sampling
    runaway ends in seconds rather than the model's three minutes. Qwen3-TTS
    makes 12 frames a second; a Han character takes about 0.3 s to say, any
    other about 0.08 s."""
    han = len(HAN.findall(text))
    seconds = 0.3 * han + 0.08 * (len(text) - han)
    return min(2048, 48 + int(4 * 12 * seconds))


def language(text):
    """Chinese when the text has Han characters (mixed text too), else English."""
    return "Chinese" if HAN.search(text) else "English"


class Stretch:
    """
    Time-stretches streamed audio by `speed` without changing its pitch
    (WSOLA: overlapping windows, each moved up to TOL samples to line up with
    the last). Holds one piece's audio, which is short.
    """

    N = 960  # 40 ms windows
    TOL = 240  # 10 ms search either way

    def __init__(self, speed):
        self.speed = speed
        self.hs = self.N // 2
        self.ha = self.hs * speed
        self.win = np.hanning(self.N + 1)[:-1].astype(np.float32)
        self.src = np.zeros(0, dtype=np.float32)
        self.out = np.zeros(self.N, dtype=np.float32)
        self.k = 0  # the next window
        self.prev = 0  # where the last window was taken from
        self.sent = 0  # output samples already given

    def _window(self, k):
        ideal = int(round(k * self.ha))
        if k == 0:
            at = 0
        else:
            target = self.src[self.prev + self.hs:self.prev + self.hs + self.N]
            lo, hi = max(0, ideal - self.TOL), ideal + self.TOL
            region = self.src[lo:hi + self.N]
            if len(target) == self.N and len(region) >= self.N:
                scores = np.correlate(region, target, mode="valid")
                at = lo + int(np.argmax(scores))
            else:
                at = ideal
        frame = self.src[at:at + self.N]
        if len(frame) < self.N:
            frame = np.pad(frame, (0, self.N - len(frame)))
        start = k * self.hs
        if len(self.out) < start + self.N:
            self.out = np.pad(self.out, (0, start + self.N - len(self.out)))
        self.out[start:start + self.N] += frame * self.win
        self.prev = at

    def feed(self, x):
        if self.speed == 1:
            return x
        self.src = np.concatenate([self.src, x])
        while int(round(self.k * self.ha)) + self.TOL + 2 * self.N <= len(self.src):
            self._window(self.k)
            self.k += 1
        return self._take(self.k * self.hs)

    def finish(self):
        if self.speed == 1:
            return np.zeros(0, dtype=np.float32)
        while int(round(self.k * self.ha)) < len(self.src):
            self._window(self.k)
            self.k += 1
        return self._take(int(round(len(self.src) / self.speed)))

    def _take(self, upto):
        upto = min(upto, len(self.out))
        chunk = self.out[self.sent:upto]
        self.sent = max(self.sent, upto)
        return chunk


def pcm(x):
    return (np.clip(np.nan_to_num(x), -1, 1) * 32767).astype("<i2").tobytes()


class Model:
    """One model on one GPU, worked by one thread of its own.

    CUDA graphs replay at full speed only on the thread that captured them
    (on another, every reading cost about 0.4 s more on danube's CMP), so
    the load, the warm-up and every reading run on the model's own thread,
    and a request only takes the audio it makes."""

    def __init__(self, folder, device):
        with open(os.path.join(folder, "config.json"), encoding="utf-8") as f:
            config = json.load(f)
        self.kind = config.get("tts_model_type")
        if config.get("model_type") != "qwen3_tts" or self.kind not in ("custom_voice", "base"):
            raise Refused(400, "invalid", "That isn't a Qwen3-TTS CustomVoice or Base model.")
        if self.kind == "custom_voice":
            speakers = (config.get("talker_config") or {}).get("spk_id") or {}
            self.voices = {s.title(): s for s in speakers}
        else:
            self.voices = builtin_voices()
        if not self.voices:
            raise Refused(400, "invalid", "That model has no voices.")
        self.device = device
        self.jobs = queue.Queue()
        self.closed = False
        self.jobs_lock = threading.Lock()
        loaded = queue.Queue()
        threading.Thread(target=self._work, args=(folder, loaded), daemon=True).start()
        failed = loaded.get()
        if failed is not None:
            raise failed

    def _work(self, folder, loaded):
        try:
            import torch

            # PyTorch 2.14 sends some ops (the RoPE outer product's bmm) to
            # Triton kernels, which need a C compiler to start; this image has
            # none, and PyTorch's own kernels serve them as well.
            from torch._native import registry

            registry.deregister_op_overrides(disable_dsl_names="triton")
            from faster_qwen3_tts import FasterQwen3TTS

            if not torch.cuda.is_available() or self.device >= torch.cuda.device_count():
                raise Refused(503, "model_unavailable", "This speech server can't see that GPU.")
            torch.cuda.set_device(self.device)
            # Volta has no bf16; newer cards use it, as the model was trained.
            dtype = torch.bfloat16 if torch.cuda.get_device_capability(self.device)[0] >= 8 else torch.float16
            self.tts = FasterQwen3TTS.from_pretrained(folder, device=f"cuda:{self.device}", dtype=dtype, attn_implementation="sdpa", local_files_only=True)
            # CUDA graphs are captured on first use: two whole sentences now, so the first one read isn't slow.
            first = next(iter(self.voices))
            with torch.inference_mode():
                for text in WARM_UP:
                    for _ in self._stream(first, text):
                        pass
        except Exception as e:  # noqa: BLE001
            loaded.put(e)
            return
        loaded.put(None)
        with torch.inference_mode():
            while (job := self.jobs.get()) is not None:
                voice, text, speed, out, stop = job
                try:
                    stretch = Stretch(speed)
                    stream = self._stream(voice, text)
                    try:
                        for chunk, _sr, _info in stream:
                            if stop.is_set():
                                break
                            audio = stretch.feed(np.asarray(chunk, dtype=np.float32).reshape(-1))
                            if len(audio):
                                out.put(pcm(audio))
                        else:
                            rest = stretch.finish()
                            if len(rest):
                                out.put(pcm(rest))
                    finally:
                        stream.close()
                    out.put(None)
                except Exception as e:  # noqa: BLE001
                    out.put(e)

    def _stream(self, voice, text):
        if self.kind == "custom_voice":
            return self.tts.generate_custom_voice_streaming(text=text, speaker=self.voices[voice], language=language(text), chunk_size=CHUNK, max_new_tokens=frame_limit(text))
        ref, transcript = self.voices[voice]
        return self.tts.generate_voice_clone_streaming(text=text, language=language(text), ref_audio=ref, ref_text=transcript, chunk_size=CHUNK, max_new_tokens=frame_limit(text))

    def speak(self, voice, text, speed):
        """The reading's PCM as it is made. Readings of one model wait their turn on its thread."""
        if voice not in self.voices:
            raise Refused(400, "invalid", "That isn't one of this model's voices.")
        out, stop = queue.Queue(), threading.Event()
        with self.jobs_lock:
            # Unloaded since the request found it: no thread would answer.
            if self.closed:
                raise Refused(503, "model_unavailable", "That voice model isn't loaded.")
            self.jobs.put((voice, text, speed, out, stop))
        try:
            while (item := out.get()) is not None:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            stop.set()  # a client that went away stops the model

    def close(self):
        with self.jobs_lock:
            self.closed = True
            self.jobs.put(None)


MODELS = {}
LOCK = threading.Lock()
# Whether this process has loaded a model on a GPU (and so holds a CUDA context).
GPU_USED = False
# Set once it will exit: it loads nothing more and isn't healthy.
EXITING = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "lyrica-speech-qwen"
    sys_version = ""

    def log_message(self, *args):  # nothing is logged
        pass

    def body(self):
        size = int(self.headers.get("content-length") or 0)
        if size > 256 * 1024:
            raise Refused(400, "invalid", "The request is too large.")
        try:
            data = json.loads(self.rfile.read(size) or b"{}")
        except ValueError:
            raise Refused(400, "invalid", "The body isn't valid JSON.") from None
        if not isinstance(data, dict):
            raise Refused(400, "invalid", "The body must be a JSON object.")
        return data

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            with LOCK:
                exiting = EXITING
                loaded = sorted(MODELS)
            # About to exit: not up, so host-api's next load waits for the fresh server.
            if exiting:
                return self.send(503, {"error": {"code": "model_unavailable", "message": "The speech server is restarting."}})
            return self.send(200, {"loaded": loaded})
        self.send(404, {"error": {"code": "not_found", "message": "Not found."}})

    def do_POST(self):
        self.streaming = False
        try:
            self.route(self.body())
        except Refused as e:
            self.send(e.status, {"error": {"code": e.code, "message": str(e)}})
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client went away: stop
        except Exception as e:  # noqa: BLE001
            if self.streaming:
                # The audio has started: cut it short rather than put an error in it.
                self.close_connection = True
                return
            # The kind of failure only, never the text.
            try:
                self.send(503, {"error": {"code": "model_unavailable", "message": f"The speech server failed ({type(e).__name__})."}})
            except OSError:
                pass

    def route(self, b):
        global GPU_USED, EXITING
        if self.path == "/load":
            name, folder, device = b.get("name"), b.get("folder"), b.get("device")
            if not all(isinstance(x, str) and x for x in (name, folder)) or not isinstance(device, int) or isinstance(device, bool) or device < 0:
                raise Refused(400, "invalid", "load needs name, folder and a GPU index.")
            real = os.path.realpath(folder)
            if not real.startswith(os.path.realpath(MODELS_DIR) + os.sep) or not os.path.isfile(os.path.join(real, "config.json")):
                raise Refused(400, "invalid", "The model must be a folder in the models folder.")
            with LOCK:
                if EXITING:
                    raise Refused(503, "model_unavailable", "The speech server is restarting.")
                loaded = name in MODELS
                GPU_USED = True  # a load that fails may still have made a CUDA context
            if not loaded:
                model = Model(real, device)
                with LOCK:
                    # An unload or reset may have set it while this one loaded.
                    if EXITING:
                        raise Refused(503, "model_unavailable", "The speech server is restarting.")
                    MODELS[name] = model
            return self.send(200, {"loaded": True})
        if self.path == "/unload":
            with LOCK:
                model = MODELS.pop(b.get("name"), None)
                EXITING = EXITING or (GPU_USED and not MODELS)
            if model is not None:
                model.close()
            return self.answer_then_exit()
        if self.path == "/reset":
            with LOCK:
                for model in MODELS.values():
                    model.close()
                MODELS.clear()
                EXITING = EXITING or GPU_USED
            return self.answer_then_exit()
        if self.path == "/v1/audio/speech":
            return self.speech(b)
        raise Refused(404, "not_found", "Not found.")

    def answer_then_exit(self):
        """Answers, then exits if set to: EXITING is set before the answer leaves, so no load can slip in."""
        self.send(200, {})
        with LOCK:
            exiting = EXITING
        if exiting:
            self.wfile.flush()
            # A moment for the answer to leave; Docker starts a fresh server.
            threading.Timer(0.2, os._exit, (0,)).start()

    def speech(self, b):
        with LOCK:
            model = MODELS.get(b.get("model"))
        if model is None:
            raise Refused(503, "model_unavailable", "That voice model isn't loaded.")
        text, voice, speed = b.get("input"), b.get("voice"), b.get("speed", 1)
        if not isinstance(text, str) or not text.strip() or len(text) > 4096:
            raise Refused(400, "invalid", "input is the text to read, 1 to 4096 characters.")
        if not isinstance(voice, str):
            raise Refused(400, "invalid", "voice is missing.")
        if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.25 <= speed <= 4:
            raise Refused(400, "invalid", "speed is from 0.25 to 4.")
        audio = model.speak(voice, text, float(speed))
        first = next(audio, b"")  # errors before any audio are answered as errors
        self.send_response(200)
        self.send_header("content-type", f"audio/pcm;rate={RATE}")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.streaming = True
        try:
            for chunk in [first] if first else []:
                self.chunk(chunk)
            for chunk in audio:
                self.chunk(chunk)
            self.wfile.write(b"0\r\n\r\n")
        finally:
            audio.close()  # a client that went away stops the reading

    def chunk(self, data):
        if data:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"qwen3-tts speech server on {PORT}", file=sys.stderr, flush=True)
    server.serve_forever()
