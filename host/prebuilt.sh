# The CMP 100-210's own images (llamacpp/, sdcpp/), built by CI
# (.github/workflows/cmp-images.yml) and pulled by install.sh, which builds
# them here only when a pull can't be had. Sourced by both, so they agree on
# where the images are, what they're built for and what they're tagged.

# The registry and namespace: the one line to change for another registry,
# such as a Forgejo instance's.
PREBUILT_REGISTRY=${LYRICA_HOST_REGISTRY:-ghcr.io/xlc2022}

# The CUDA capabilities each published image is built for. llama.cpp runs on
# every GPU of the host, so its list covers the cards a CMP is likely to sit
# beside; sd-server runs on the CMP alone.
prebuilt_archs() {
  case $1 in
    llamacpp) echo "70-real;75-real;80-real;86-real;89-real;120-real" ;;
    sdcpp) echo "70-real" ;;
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
# nothing, saying why it will be built here instead.
prebuilt_pick() {
  PREBUILT=$(prebuilt_image "$1")
  local why
  if ! prebuilt_covers "$1" "$2"; then why="the published image isn't built for CUDA $2"
  elif [[ $3 != 1 ]]; then return
  elif ! docker pull -q "$PREBUILT" >/dev/null 2>&1; then why="$PREBUILT couldn't be pulled"
  elif [[ $(docker image inspect -f '{{index .Config.Labels "org.lyrica.content"}}' "$PREBUILT" 2>/dev/null) != "${PREBUILT##*:}" ]]; then why="$PREBUILT doesn't carry its own tag as its content label"
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
