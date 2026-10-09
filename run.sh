#!/bin/sh
# mactop-web launcher
cd "$(dirname "$0")"
exec python3 server.py "$@"
