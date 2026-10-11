# Speech benchmark (Windows, NVIDIA)

Compares the voices Lyrica could speak with (Kokoro, Chatterbox
multilingual, CosyVoice 2) and the dictation models (Whisper large-v3-turbo,
Voxtral Mini), on English, Mandarin and the two mixed. It runs on the GPU
named RTX 3090 if there is one, else the first.

1. Optional, and the most useful test of dictation: record yourself saying
   the three sentences below with Sound Recorder (set the format to WAV or
   FLAC in its settings), and save them in `recordings\` as `en`, `zh` and
   `mixed`. Only the transcripts go into the results, never the recordings.
   - en: I put the recipe in the chat, so you can look at it when you're back in the kitchen.
   - zh: 我把菜谱放在聊天里了，你回到厨房的时候可以看一下。
   - mixed: 明天下午三点的 meeting 改到 Zoom 上了，记得带上 laptop。
2. In this folder, run:

   ```
   powershell -ExecutionPolicy Bypass -File run.ps1
   ```

   It installs uv if needed, then sets up each model in its own Python
   environment in `work\` and downloads it. That takes a while and about
   40 GB of disk. A model that fails to install or run is noted, and the
   rest carry on.
3. Send back `lyrica-speech-bench-results.zip`. It holds `results.md`, the
   raw numbers, the logs and the voice samples (`samples\`), which you can
   listen to first.

Delete the folder afterwards to get the space back. Nothing here touches
the model host or its models folder. `-Only kokoro,stt` runs only some
parts.
