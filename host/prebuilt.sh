# The CMP 100-210's own images (llamacpp/, sdcpp/, whispercpp/), built by CI
# (.github/workflows/cmp-images.yml) and pulled by install.sh, which builds
# them here only when a pull can't be had. Sourced by both, so they agree on
# where the images are, what they're built for and what they're tagged.

# The registry and namespace: the one line to change for another registry,
# such as a Forgejo instance's.
PREBUILT_REGISTRY=${LYRICA_HOST_REGISTRY:-ghcr.io/xlc2022}

# The CUDA capabilities each published image is built for. llama.cpp and
# whisper-server run on any GPU of the host, so their list covers the cards a
# CMP is likely to sit beside; sd-server runs on the CMP alone.
prebuilt_archs() {
  case $1 in
    llamacpp) echo "70-real;75-real;80-real;86-real;89-real;120-real" ;;
    sdcpp) echo "70-real" ;;
    whispercpp) echo "70-real;75-real;80-real;86-real;89-real;120-real" ;;
  esac
}

# An image's tag: a hash of its build context (the Dockerfile, which pins its
# base images and source commit, and the files beside it) and the
# capabilities it's built for. Run from host/.
prebuilt_tag() {
  {
    (cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$f" "$(sha256sum <"$f" | cut -d' ' -f1)"; done)
    prebuilt_archs "$1"
  } | sha256sum | cut -c1-16
}

prebuilt_image() { echo "$PREBUILT_REGISTRY/lyrica-host-$1:$(prebuilt_tag "$1")"; }

# Sets PREBUILT to the published image of $1 when it covers CUDA $2 and, if
# $3 is 1, it pulls and carries its own tag as its content label; else to
# nothing, saying why it will be built here instead. A pulled image is named
# by its digest, so every later start runs exactly the image checked here
# even if the tag is pushed again. Without a pull (--no-start: CI, on hosts
# with no CMP, and Lyrica's model-host skill before its install step) it
# stays the unchecked tag, which the next run without --no-start pulls and
# checks, or builds.
prebuilt_pick() {
  PREBUILT=$(prebuilt_image "$1")
  local why repo=${PREBUILT%:*}
  if ! prebuilt_covers "$1" "$2"; then why="the published image isn't built for CUDA $2"
  elif [[ $3 != 1 ]]; then return
  elif ! docker pull -q "$PREBUILT" >/dev/null 2>&1; then why="$PREBUILT couldn't be pulled"
  elif [[ $(docker image inspect -f '{{index .Config.Labels "org.lyrica.content"}}' "$PREBUILT" 2>/dev/null) != "${PREBUILT##*:}" ]]; then why="$PREBUILT doesn't carry its own tag as its content label"
  elif ! PREBUILT=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$PREBUILT" 2>/dev/null | grep -m1 "^$repo@"); then why="the pulled image has no digest from $repo"
  else echo "CMP 100-210: pulled $PREBUILT."; return
  fi
  echo "CMP 100-210: building $1 here from source, which takes a while the first time: $why."
  PREBUILT=
}

# Whether every capability in a list like "61-real;70-real" is in the image's.
prebuilt_covers() {
  local have=";$(prebuilt_archs "$1");" a want
  IFS=';' read -ra want <<<"$2"
  for a in "${want[@]}"; do [[ $have == *";$a;"* ]] || return 1; done
}

# The image GPUs (COMFY_GPU) on a host with a CMP 100-210: $1 is .env's
# COMFY_GPU (empty on a first install), $2 the CMPs' indices and $3 the other
# NVIDIA cards', each space-separated. ComfyUI can't run on a CMP, and
# stable-diffusion.cpp makes images on one GPU only, creating but never
# editing, so beside another card the images go there: on a first install
# the first other card; a list naming both drops its CMPs. A list of CMPs
# alone stays, and sd.cpp makes the images on the first. Prints the list.
image_gpus() {
  local g kept=() dropped=() others
  read -ra others <<<"$3"
  if [[ ${#others[@]} -eq 0 ]]; then echo "${1:-0}"; return; fi
  if [[ -z $1 ]]; then
    echo "CMP 100-210 beside another card: images on GPU ${others[0]} with ComfyUI." >&2
    echo "${others[0]}"; return
  fi
  for g in ${1//,/ }; do
    if [[ " $2 " == *" $g "* ]]; then dropped+=("$g"); else kept+=("$g"); fi
  done
  if [[ ${#kept[@]} -eq 0 ]]; then
    echo "Images on the CMP 100-210 (GPU $1) with stable-diffusion.cpp, which creates but doesn't edit; COMFY_GPU=${others[0]} in host/.env puts them on GPU ${others[0]} with ComfyUI." >&2
    echo "$1"; return
  fi
  [[ ${#dropped[@]} -eq 0 ]] || echo "COMFY_GPU leaves out GPU ${dropped[*]}: ComfyUI can't run on a CMP 100-210." >&2
  (IFS=,; echo "${kept[*]}")
}

# Whether every NVIDIA card is a CMP 100-210: $1 is nvidia-smi's
# "index, pci.device_id" lines. vLLM can't run on one, so such a host leaves
# it out (compose.novllm.yaml). No lines (nvidia-smi failed) isn't.
cmp_only() {
  [[ -n $1 ]] && ! grep -qviE ',[[:space:]]*0x(1df4|1d84)10de$' <<<"$1"
}
