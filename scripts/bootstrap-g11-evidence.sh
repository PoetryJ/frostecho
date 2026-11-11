#!/usr/bin/env bash
# Restore the archived G11 run evidence into a clean clone.
# Refuses to overwrite any existing g11-live directory (new batches are never
# replaced). Verifies the packaged SHA256 before extraction.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${REPO}/evidence/g11-original-evidence.tar.gz"
SUMS="${REPO}/evidence/g11-original-evidence.sha256"

if [[ ! -f "${PKG}" || ! -f "${SUMS}" ]]; then
  echo "missing evidence package under ${REPO}/evidence" >&2
  exit 1
fi

if [[ -e "${REPO}/artifacts/g11-live/g11-live-20261105-r1" ]]; then
  echo "g11-live evidence already present; refusing to overwrite"
  exit 0
fi

(cd "${REPO}/evidence" && sha256sum -c "$(basename "${SUMS}")")
mkdir -p "${REPO}/artifacts"
tar -xzf "${PKG}" -C "${REPO}"
echo "restored g11 evidence to ${REPO}/artifacts/g11-live"
