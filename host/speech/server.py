#!/usr/bin/env python3
"""Lyrica's speech server: Kokoro voice models (ONNX), on one GPU or the CPU.

Only host-api talks to it, on the models network, which has no route out. It
logs nothing and writes nothing: the models folder is read-only, and the only
writable place is /tmp, a tmpfs. Text it is asked to read is never kept.

- POST /load   {"name", "folder", "file", "device": <GPU index> | "cpu"}
- POST /unload {"name"}
- POST /reset  {}
- POST /v1/audio/speech {"model", "input", "voice", "speed"}: 16-bit mono PCM
  at 24 kHz, streamed as each part of the text is made.
- GET  /health
"""
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort

RATE = 24000
MAX_TOKENS = 510  # Kokoro's longest input; longer text is read in parts
PORT = int(os.environ.get("SPEECH_PORT", "8000"))

if hasattr(ort, "preload_dlls"):
    ort.preload_dlls()  # CUDA and cuDNN from the nvidia-* wheels, in the CUDA image

import espeakng_loader  # noqa: E402
from phonemizer.backend.espeak.wrapper import EspeakWrapper  # noqa: E402

EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
from misaki import en, espeak, zh  # noqa: E402

CJK = re.compile(r"([　-〿一-鿿＀-￯]+)")
# Where a long text may be cut: after a sentence, then a clause, then a word.
BREAKS = [re.compile(r"(?<=[.!?。！？])\s*"), re.compile(r"(?<=[,;:，；：、])\s*"), re.compile(r"\s+")]


class Refused(Exception):
    """A request this server won't serve: a plain sentence for host-api, never the text."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


class Voices:
    """Phonemizers, made once and shared: misaki's English and Mandarin G2P."""

    def __init__(self):
        self.lock = threading.RLock()
        self._en = {}
        self._zh = {}

    def english(self, british):
        with self.lock:
            if british not in self._en:
                self._en[british] = en.G2P(trf=False, british=british, fallback=espeak.EspeakFallback(british=british))
            return self._en[british]

    def mandarin(self, version):
        with self.lock:
            if version not in self._zh:
                g = self.english(False)
                self._zh[version] = zh.ZHG2P(version=version, en_callable=lambda s: g(s)[0]) if version else zh.ZHG2P()
            return self._zh[version]

    def phonemes(self, voice, text, version):
        """Phonemes for a voice: a and b voices read English, z voices Mandarin with English words in it."""
        if voice[0] in "ab":
            return self.english(voice[0] == "b")(text)[0]
        g = self.mandarin(version)
        if version:
            out = g(text)
            return out[0] if isinstance(out, tuple) else out
        # Kokoro 1.0's Mandarin G2P leaves English as letters: read those runs as English.
        english = self.english(False)
        parts = []
        for run in CJK.split(text):
            if not run.strip():
                parts.append(run)
            elif CJK.fullmatch(run):
                out = g(run)
                parts.append(out[0] if isinstance(out, tuple) else out)
            else:
                parts.append(english(run)[0])
        return "".join(parts)


VOICES = Voices()


class Model:
    def __init__(self, folder, file, device):
        if device == "cpu":
            providers = ["CPUExecutionProvider"]
        else:
            if "CUDAExecutionProvider" not in ort.get_available_providers():
                raise Refused(503, "model_unavailable", "This speech server has no GPU support; it runs voices on the CPU.")
            providers = [("CUDAExecutionProvider", {"device_id": int(device)}), "CPUExecutionProvider"]
        self.folder = folder
        options = ort.SessionOptions()
        options.log_severity_level = 3
        self.session = ort.InferenceSession(os.path.join(folder, file), sess_options=options, providers=providers)
        names = [i.name for i in self.session.get_inputs()]
        self.ids = "input_ids" if "input_ids" in names else "tokens"
        self.vocab = self._vocab()
        # Kokoro 1.1's Mandarin uses zhuyin; 1.0's, IPA.
        self.version = "1.1" if "ㄅ" in self.vocab else None
        self.styles = {}
        # Load the phonemizers now, so the first sentence isn't slow.
        VOICES.phonemes("zf_", "你好, hello.", self.version)

    def _vocab(self):
        for name, keys in (("config.json", ("vocab",)), ("tokenizer.json", ("model", "vocab"))):
            try:
                with open(os.path.join(self.folder, name), encoding="utf-8") as f:
                    v = json.load(f)
                for k in keys:
                    v = v[k]
                if isinstance(v, dict):
                    return v
            except (OSError, KeyError, TypeError, ValueError):
                continue
        raise Refused(503, "model_unavailable", "The voice model has no vocabulary.")

    def style(self, voice):
        if voice not in self.styles:
            if not re.fullmatch(r"[a-z]{2}_[\w-]+", voice):
                raise Refused(400, "invalid", "That isn't one of this model's voices.")
            path = os.path.join(self.folder, "voices", f"{voice}.bin")
            if not os.path.isfile(path):
                raise Refused(400, "invalid", "That isn't one of this model's voices.")
            # Plain float32 numbers, never unpickled.
            self.styles[voice] = np.fromfile(path, dtype=np.float32).reshape(-1, 1, 256)
        return self.styles[voice]

    def tokens(self, phonemes):
        return [self.vocab[c] for c in phonemes if c in self.vocab]

    def parts(self, voice, text):
        """The text's phonemes, cut where it reads naturally so each part fits."""
        todo = [text]
        while todo:
            piece = todo.pop(0).strip()
            if not piece:
                continue
            ph = VOICES.phonemes(voice, piece, self.version)
            tokens = self.tokens(ph)
            if len(tokens) <= MAX_TOKENS:
                if tokens:
                    yield tokens
                continue
            for pattern in BREAKS:
                pieces = [p for p in pattern.split(piece) if p.strip()]
                if len(pieces) > 1:
                    half = len(pieces) // 2
                    todo[:0] = [" ".join(pieces[:half]) if pattern is BREAKS[2] else "".join(pieces[:half]),
                                " ".join(pieces[half:]) if pattern is BREAKS[2] else "".join(pieces[half:])]
                    break
            else:
                # One word too long to say: cut its phonemes.
                for i in range(0, len(tokens), MAX_TOKENS):
                    yield tokens[i:i + MAX_TOKENS]

    def speak(self, voice, text, speed):
        styles = self.style(voice)
        for tokens in self.parts(voice, text):
            feed = {
                self.ids: np.array([[0, *tokens, 0]], dtype=np.int64),
                "style": styles[min(len(tokens), len(styles) - 1)].astype(np.float32),
                "speed": np.array([speed], dtype=np.float32),
            }
            audio = np.asarray(self.session.run(None, feed)[0], dtype=np.float32).reshape(-1)
            yield (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


MODELS = {}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "lyrica-speech"
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
                return self.send(200, {"loaded": sorted(MODELS)})
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
        if self.path == "/load":
            name, folder, file, device = b.get("name"), b.get("folder"), b.get("file"), b.get("device")
            if not all(isinstance(x, str) and x for x in (name, folder, file)) or not (device == "cpu" or isinstance(device, int)):
                raise Refused(400, "invalid", "load needs name, folder, file and device.")
            real = os.path.realpath(os.path.join(folder, file))
            if not real.startswith(os.path.realpath(MODELS_DIR) + os.sep) or not real.endswith(".onnx"):
                raise Refused(400, "invalid", "The model must be an .onnx file in the models folder.")
            with LOCK:
                loaded = name in MODELS
            if not loaded:
                model = Model(folder, file, device)
                with LOCK:
                    MODELS[name] = model
            return self.send(200, {"loaded": True})
        if self.path == "/unload":
            with LOCK:
                MODELS.pop(b.get("name"), None)
            return self.send(200, {})
        if self.path == "/reset":
            with LOCK:
                MODELS.clear()
            return self.send(200, {})
        if self.path == "/v1/audio/speech":
            return self.speech(b)
        raise Refused(404, "not_found", "Not found.")

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
        if not isinstance(speed, (int, float)) or not 0.25 <= speed <= 4:
            raise Refused(400, "invalid", "speed is from 0.25 to 4.")
        audio = model.speak(voice, text, float(speed))
        first = next(audio, b"")  # errors before any audio are answered as errors
        self.send_response(200)
        self.send_header("content-type", f"audio/pcm;rate={RATE}")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.streaming = True
        for chunk in [first] if first else []:
            self.chunk(chunk)
        for chunk in audio:
            self.chunk(chunk)
        self.wfile.write(b"0\r\n\r\n")

    def chunk(self, data):
        if data:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()


MODELS_DIR = os.environ.get("MODELS_DIR", "/models")

if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"speech server on {PORT}", file=sys.stderr, flush=True)
    server.serve_forever()
