#!/bin/sh
# make-room.sh GB: before a large image build on the self-hosted runners, which
# keep Docker's cache between jobs. With less than GB free where Docker keeps
# its data, clear the build cache, then if still short the images no container
# uses (the next build fetches them again), and fail if there still isn't room.
# Docker's containerd store keeps layers under /var/lib/containerd; on the
# runner VM that is the same filesystem as /var/lib/docker.
set -eu
need=$1
avail() { df -BG --output=avail /var/lib/docker | tail -1 | tr -dc 0-9; }
echo "Free: $(avail) GB; this build needs $need GB."
if [ "$(avail)" -lt "$need" ]; then
  docker system df
  docker builder prune -af >/dev/null
  echo "Free after clearing the build cache: $(avail) GB."
fi
if [ "$(avail)" -lt "$need" ]; then
  docker image prune -af >/dev/null
  echo "Free after clearing unused images: $(avail) GB."
fi
if [ "$(avail)" -lt "$need" ]; then
  df -h /
  echo "::error::This runner has $(avail) GB free for Docker and the build needs $need GB. Give the VM more disk (docs/ci.md, The runner)."
  exit 1
fi
