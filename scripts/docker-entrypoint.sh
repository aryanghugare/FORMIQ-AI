#!/bin/sh
set -eu
# A newly mounted disk may be owned by root. Prepare its top-level directory,
# then run the application as the unprivileged formiq user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${FORMIQ_DATA_DIR:-/app/data}"
  chown formiq:formiq "${FORMIQ_DATA_DIR:-/app/data}"
  exec su-exec formiq "$@"
fi
exec "$@"
