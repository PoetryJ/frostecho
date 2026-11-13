"""Generate/check a portable evidence manifest; never includes itself."""
import argparse
import hashlib
from pathlib import Path
import sys
sys.dont_write_bytecode = True
from preflight import verify_manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory')
    parser.add_argument('--name', default='PACKAGE-SHA256')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    root = Path(args.directory).resolve()
    if Path(args.name).name != args.name:
        raise SystemExit('manifest name must be a filename')
    target = root / args.name
    if args.verify:
        print(verify_manifest(root, target))
        return
    forbidden = {'.git', 'node_modules', 'dist', 'acceptance-clone', '__pycache__'}
    lines = []
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if set(relative.parts) & forbidden:
            raise SystemExit('exclude work/dependency/cache trees from delivery: ' + str(relative))
        if path.is_symlink():
            raise SystemExit('symlink not allowed in evidence manifest: ' + str(relative))
        if path.is_file() and path != target:
            lines.append(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + relative.as_posix())
    if not lines:
        raise SystemExit('empty evidence directory')
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    print(verify_manifest(root, target))


if __name__ == '__main__':
    main()
