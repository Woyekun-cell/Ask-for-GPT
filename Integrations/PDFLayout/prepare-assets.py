#!/usr/bin/env python3
"""Explicit online installation step; never called by a PDF translation job."""
import argparse
import hashlib
import importlib.metadata
import logging
from pathlib import Path
import os
from platform_ops import protect_path

from layout_common import BABELDOC_VERSION, atomic_json, configure_asset_home, private_directory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-root", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    root = private_directory(args.cache_root)
    assets = configure_asset_home(root)
    if importlib.metadata.version("BabelDOC") != BABELDOC_VERSION:
        raise SystemExit("runtime_version_mismatch")
    logging.basicConfig(level=logging.ERROR, format="%(levelname)s: asset preparation failed")
    from babeldoc.assets.assets import warmup
    print("Preparing verified public PDF layout model, fonts, and CMaps.", flush=True)
    warmup()
    records = []
    for path in sorted(assets.rglob("*")):
        if path.relative_to(assets).parts[0] not in {"models", "fonts", "cmap", "tiktoken"}:
            continue
        if path.is_file():
            protect_path(path)
            records.append({"name": path.relative_to(assets).as_posix(), "bytes": path.stat().st_size,
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        elif path.is_dir():
            protect_path(path, directory=True)
    atomic_json(root / "assets-ready.json", {"babeldoc": BABELDOC_VERSION, "files": records,
        "bytes": sum(record["bytes"] for record in records)})
    print(f"Assets ready: {len(records)} files, {sum(record['bytes'] for record in records)} bytes.", flush=True)


if __name__ == "__main__": main()
