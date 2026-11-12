set -eu
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
src=/data3/DATA/project/project_meishijiang/FrostEcho
out=$(mktemp -d /tmp/frostecho-r5-product-XXXXXX)
printf '%s\n' "$out"
git clone -b codex/sprint-1116 "$src/artifacts/sprint-r5/delivery/frostecho-r5.bundle" "$out/repo" > "$out/clone.log" 2>&1
cd "$out/repo"
git rev-parse HEAD
npm ci --offline > "$out/install.log" 2>&1
npm run build > "$out/build.log" 2>&1
cp "$src/handoff/20261112-sprint-r5/repros/world-probe.cjs" "$out/world-probe.cjs"
node "$out/world-probe.cjs" "$out/repo" "$out/probe-output" > "$out/world-probe.log" 2>&1
node --test --test-reporter=tap dist/tests/acceptance-v5/*.test.js > "$out/acceptance-v5.tap" 2>&1
printf 'DONE=%s\n' "$out"