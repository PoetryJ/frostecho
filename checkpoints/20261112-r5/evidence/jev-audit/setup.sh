set -eu
src=/data3/DATA/project/project_meishijiang/FrostEcho
out=$(mktemp -d /tmp/frostecho-r5-jev-XXXXXX)
printf '%s\n' "$out"
git clone -b codex/sprint-1116 "$src/artifacts/sprint-r5/delivery/frostecho-r5.bundle" "$out/repo" > "$out/clone.log" 2>&1
cd "$out/repo"
git rev-parse HEAD
find research/decision-choice/jev04 -maxdepth 4 -type f | grep -E 'test|v4/|encoder_train|port_v3|prepare_t27'
printf 'OUT=%s\n' "$out"