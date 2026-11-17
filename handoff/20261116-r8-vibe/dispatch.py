"""Small, offline dispatcher. Does not launch agents, install packages or run GPUs."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BASELINE = "6407705c53a462a3d539e582187dd3f6bcb00bf5"
ROLES = ("O", "P1", "P2", "P3", "P4", "A", "D", "M", "H")


def git(*args: str, check: bool = True):
    return subprocess.run(["git", "-C", str(REPO), *args], check=check,
                          text=True, encoding="utf-8", capture_output=True)


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify():
    count = 0
    for line in (HERE / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        expected, relative = line.split("  ", 1)
        path = (HERE / relative).resolve()
        if not path.is_relative_to(HERE) or sha(path) != expected:
            raise ValueError(f"Package mismatch: {relative}")
        count += 1
    git("merge-base", "--is-ancestor", BASELINE, "HEAD")
    print(json.dumps({"ok": True, "files": count,
                      "sourceHEAD": git("rev-parse", "HEAD").stdout.strip(),
                      "productBaseline": BASELINE, "gameOrModelExecuted": False}))


def brief(role: str):
    print(f"PACKAGE: {HERE}\nROLE: {role}\n")
    print((HERE / "COMMON.txt").read_text(encoding="utf-8"))
    if role == "O":
        print((HERE / "CONTRACT.txt").read_text(encoding="utf-8"))
    print((HERE / "workers" / f"{role}.txt").read_text(encoding="utf-8"))
    if role != "O":
        print("共享具体类型由 O 的 contracts-freeze 提交提供；只按该提交的 src/r7/contracts.ts 和既有 Choice 契约接线。")


def worktrees(base: str, output: Path):
    """Prepare eight isolated writers without resetting or overwriting any tree."""
    if not output.is_absolute():
        raise ValueError("--out must be an absolute directory")
    output = output.resolve()
    if output == REPO or REPO.is_relative_to(output):
        raise ValueError("--out must not be the repository or its ancestor")
    freeze = git("rev-parse", "--verify", f"{base}^{{commit}}").stdout.strip()
    git("merge-base", "--is-ancestor", BASELINE, freeze)
    # A real freeze must carry the task package and the owner-created API.
    for required in ("src/r7/contracts.ts", "handoff/20261116-r8-vibe/START.txt"):
        git("cat-file", "-e", f"{freeze}:{required}")
    rows = []
    # Preflight every destination before the first mutation. Existing work is never reset.
    for role in ROLES[1:]:
        branch = f"codex/r8-{role.lower()}"
        destination = output / role.lower()
        if destination.exists():
            raise ValueError(f"Existing worktree/path: {destination}; inspect and reuse manually")
        exists = git("show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False)
        if exists.returncode == 0:
            raise ValueError(f"Existing branch {branch}; inspect and reuse manually")
        if exists.returncode != 1:
            raise ValueError(f"Cannot inspect branch {branch}: {exists.stderr}")
        rows.append({"role": role, "branch": branch, "path": str(destination)})
    output.mkdir(parents=True, exist_ok=True)
    for row in rows:
        git("worktree", "add", "-b", row["branch"], row["path"], freeze)
        print(json.dumps({**row, "freeze": freeze, "created": True}), flush=True)
    print("Worktrees ready. No agents started. Dispatch each role separately; record actual session IDs.")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("verify")
    prompt = commands.add_parser("brief")
    prompt.add_argument("role", choices=ROLES)
    prepare = commands.add_parser("worktrees")
    prepare.add_argument("--base", required=True, help="Owner's committed contracts-freeze SHA")
    prepare.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "verify":
        verify()
    elif args.command == "brief":
        brief(args.role)
    else:
        worktrees(args.base, args.out)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"STOP: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        raise SystemExit(1)
