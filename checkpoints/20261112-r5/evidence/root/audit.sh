set -eu
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
src=/data3/DATA/project/project_meishijiang/FrostEcho
out=$(mktemp -d /tmp/frostecho-r5-root-498c000-XXXXXX)
printf '%s\n' "$out"
cd "$src"
git rev-parse HEAD > "$out/server-head.txt"
git status --short > "$out/server-status.txt"
git bundle verify artifacts/sprint-r5/delivery/frostecho-r5.bundle > "$out/bundle-verify.log" 2>&1
(cd artifacts/sprint-r5/delivery && sha256sum -c PACKAGE-SHA256) > "$out/package-check.log" 2>&1
(cd handoff/20261112-sprint-r5 && sha256sum -c SHA256SUMS.txt) > "$out/task-check.log" 2>&1
git clone -b codex/sprint-1116 "$src/artifacts/sprint-r5/delivery/frostecho-r5.bundle" "$out/repo" > "$out/clone.log" 2>&1
cd "$out/repo"
git rev-parse HEAD
git fsck --no-reflogs > "$out/fsck.log" 2>&1
git archive --format=tar HEAD > "$out/submission.tar"
node --version
npm ci > "$out/install.log" 2>&1
npm run build > "$out/build.log" 2>&1
bash scripts/bootstrap-g11-evidence.sh > "$out/g11-bootstrap.log" 2>&1
set +e
node dist/scripts/eval-full.js --out "$out/eval-full" > "$out/eval-full.log" 2>&1
code=$?
printf '%s\n' "$code" > "$out/eval-full.exit"
printf 'eval-full exit=%s\n' "$code"
cat "$out/eval-full.log"
printf 'AUDIT_DIR=%s\n' "$out"
exit "$code"