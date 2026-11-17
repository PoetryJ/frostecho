set -u
export CUDA_VISIBLE_DEVICES=''
export HF_HUB_OFFLINE=1
out=/tmp/frostecho-r5-jev-O2EYv5
cd "$out/repo"
mkdir -p "$out/output"
python3 -m pytest research/decision-choice/jev04/tests research/decision-choice/jev04/scorers/tests -q > "$out/output/python-tests.log" 2>&1
code=$?
cat "$out/output/python-tests.log"
printf 'PYTEST_EXIT=%s\n' "$code"
python3 research/decision-choice/jev04/data/v4/validate_v4.py > "$out/output/data-validation.json" 2> "$out/output/data-validation.stderr"
printf 'VALIDATE_EXIT=%s\n' "$?"
python3 research/decision-choice/jev04/models/encoder_train.py > "$out/output/formal-entry.json" 2> "$out/output/formal-entry.stderr"
printf 'FORMAL_EXIT=%s\n' "$?"