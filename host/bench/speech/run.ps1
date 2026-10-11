# Lyrica's speech benchmark, for Windows with an NVIDIA GPU (an RTX 3090 if
# there is one). Run it from this folder:
#
#   powershell -ExecutionPolicy Bypass -File run.ps1
#
# It installs uv if it's missing, makes one Python environment per model in
# work\, downloads the models from Hugging Face, and writes everything to
# results\. At the end it zips results\ to lyrica-speech-bench-results.zip,
# which is the file to send back. Delete this folder afterwards to get the
# space back (about 40 GB).
param(
  # Run only some parts: kokoro, chatterbox, cosyvoice, stt.
  [string[]]$Only = @("kokoro", "chatterbox", "cosyvoice", "stt")
)

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$work = Join-Path $root "work"
$out = Join-Path $root "results"
$logs = Join-Path $out "logs"
New-Item -ItemType Directory -Force -Path $work, $out, $logs, (Join-Path $root "recordings") | Out-Null

function Note([string]$text) { Write-Host "== $text" -ForegroundColor Cyan }
function Problem([string]$part, [string]$text) {
  Write-Host "!! $text" -ForegroundColor Yellow
  $line = @{ part = $part; error = $text; at = (Get-Date -Format s) } | ConvertTo-Json -Compress
  Add-Content -Path (Join-Path $out "results.jsonl") -Value $line -Encoding UTF8
}

# The GPU: the 3090 if there is one, else the first. Numbered as nvidia-smi does.
if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  Write-Host "nvidia-smi isn't on PATH: install or update the NVIDIA driver first." -ForegroundColor Red
  exit 1
}
$gpus = @(& nvidia-smi --query-gpu=index,name,memory.total,memory.used,driver_version --format=csv,noheader)
$gpus | ForEach-Object { Write-Host "   GPU $_" }
$pick = $gpus | Where-Object { $_ -match "3090" } | Select-Object -First 1
if (-not $pick) { $pick = $gpus[0] }
$index = ($pick -split ",")[0].Trim()
Note "Using GPU $pick"
$env:CUDA_DEVICE_ORDER = "PCI_BUS_ID"
$env:CUDA_VISIBLE_DEVICES = $index
$env:BENCH_NVML_INDEX = $index
$env:HF_HOME = Join-Path $work "hf"
$env:BENCH_WORK = $work
$env:BENCH_RECORDINGS = Join-Path $root "recordings"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$gpus | Out-File -FilePath (Join-Path $logs "gpus.txt") -Encoding utf8

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Note "Installing uv (astral.sh)"
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

$espeakAndG2p = @("misaki==0.9.4", "num2words", "spacy", "phonemizer-fork", "espeakng-loader", "jieba", "pypinyin", "pypinyin-dict", "cn2an", "ordered-set",
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl")
$parts = [ordered]@{
  kokoro     = @{ python = "3.12"; torch = $null; script = "bench_kokoro.py"
                  packages = @("onnxruntime-gpu[cuda,cudnn]==1.23.2", "numpy", "soundfile", "huggingface_hub", "nvidia-ml-py") + $espeakAndG2p }
  chatterbox = @{ python = "3.11"; torch = "cu124"; script = "bench_chatterbox.py"
                  packages = @("chatterbox-tts==0.1.7", "setuptools<81", "soundfile", "nvidia-ml-py") }
  cosyvoice  = @{ python = "3.10"; torch = "cu121"; script = "bench_cosyvoice.py"
                  packages = @("torch==2.3.1", "torchaudio==2.3.1", "conformer==0.3.2", "diffusers==0.29.0", "hydra-core==1.3.2", "HyperPyYAML==1.2.3",
                    "inflect==7.3.1", "librosa==0.10.2", "lightning==2.2.4", "modelscope==1.20.0", "networkx==3.1", "numpy==1.26.4", "omegaconf==2.3.0",
                    "onnx==1.16.0", "onnxruntime==1.18.0", "openai-whisper==20250625", "setuptools<81", "protobuf==4.25.8", "pyarrow==18.1.0", "pydantic==2.7.0",
                    "pyworld==0.3.4", "rich", "soundfile==0.12.1", "transformers==4.51.3", "x-transformers==2.11.24", "wetext==0.0.4", "einops", "matplotlib",
                    "huggingface_hub<1", "nvidia-ml-py") }
  stt        = @{ python = "3.12"; torch = "cu128"; script = "bench_stt.py"
                  packages = @("torch", "transformers", "accelerate", "librosa", "soundfile", "jiwer", "opencc-python-reimplemented",
                    "mistral-common[audio]", "huggingface_hub", "nvidia-ml-py") }
}

foreach ($name in $parts.Keys) {
  if ($Only -notcontains $name) { continue }
  $p = $parts[$name]
  $venv = Join-Path $work "venv-$name"
  $python = Join-Path $venv "Scripts\python.exe"
  $log = Join-Path $logs "$name.log"
  Note "$name`: setting up Python $($p.python) in $venv"
  if (-not (Test-Path $python)) { uv venv --python $p.python $venv 2>&1 | Out-File -FilePath $log -Append -Encoding utf8 }
  $uvArgs = @("pip", "install", "--python", $python)
  if ($p.torch) { $uvArgs += "--torch-backend=$($p.torch)" }
  uv @uvArgs @($p.packages) 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Problem "setup" "$name`: installing its packages failed; see logs\$name.log"
    continue
  }
  Note "$name`: running (this downloads its models the first time)"
  & $python (Join-Path $root $p.script) $out 2>&1 | Tee-Object -FilePath $log -Append
  if ($LASTEXITCODE -ne 0) { Problem "run" "$name`: the script stopped with exit code $LASTEXITCODE; see logs\$name.log" }
}

# The summary needs only Python; any of the environments will do.
$any = Get-ChildItem -Path $work -Filter python.exe -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*venv-*\Scripts\*" } | Select-Object -First 1
if ($any) { & $any.FullName (Join-Path $root "summarize.py") $out }

$zip = Join-Path $root "lyrica-speech-bench-results.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip
Note "Done. Send this file back: $zip"
Note "The voice samples are in $(Join-Path $out 'samples') if you want to listen first."
explorer.exe "/select,`"$zip`""
