#!/usr/bin/env bash
# Install dependencies from the committed lockfile into this checkout only.
# Never touches the shared dependency directory.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm ci --no-audit --no-fund
