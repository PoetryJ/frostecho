#!/usr/bin/env bash
# Restore the archived G11 run evidence into a clean clone.
#
# The baseline tracks two g11 files (plan.json, offline-ready.json), so the
# target directory can exist while the run files are missing. Completeness is
# therefore checked by the actual run file, and extraction copies only missing
# files: an existing batch is never overwritten.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${REPO}/evidence/g11-original-evidence.tar.gz"
SUMS="${REPO}/evidence/g11-original-evidence.sha256"
MARKER="${REPO}/artifacts/g11-live/g11-live-20261105-r1/w1/w1-wait-run.run.json"

if [[ ! -f "${PKG}" || ! -f "${SUMS}" ]]; then
  echo "missing evidence package under ${REPO}/evidence" >&2
  exit 1
fi

if [[ -e "${MARKER}" ]]; then
  echo "g11-live run evidence already complete; refusing to overwrite"
  exit 0
fi

(cd "${REPO}/evidence" && sha256sum -c "$(basename "${SUMS}")")
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
tar -xzf "${PKG}" -C "${TMP}"
count=0
while IFS= read -r -d '' file; do
  relative="${file#${TMP}/}"
  target="${REPO}/${relative}"
  if [[ ! -e "${target}" ]]; then
    mkdir -p "$(dirname "${target}")"
    cp "${file}" "${target}"
    count=$((count + 1))
  fi
done < <(find "${TMP}" -type f -print0)
echo "restored ${count} g11 evidence files under ${REPO}/artifacts/g11-live"
