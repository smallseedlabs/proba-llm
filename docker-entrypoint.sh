#!/bin/sh
set -e
dir="${TURN_STORE_DIR:-/app/data/turns}"
mkdir -p "$dir"
chown -R proba:proba /app/data
exec su-exec proba:proba node dist/main.js
