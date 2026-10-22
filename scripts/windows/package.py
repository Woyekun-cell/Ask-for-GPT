#!/usr/bin/env python3
"""Assemble an allowlisted Windows bundle; never read user configuration."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[2]
VERSION = "0.1.0-preview.1"
IGNORED = {"tests", "test", "__pycache__", "node_modules", "bin", "obj", ".git"}
SECRET_NAMES = {"auth.json", "windows-settings.json", "inline-connection.json", "connection.local.json", "translation-configuration.json"}
SECRETS = [re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
           re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
           re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{50,}\b"),
           re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b")]
REQUIRED = {"AskGPT.Windows.exe", "AskGPT.Translate.exe", "Resources/Dictionary/words.sqlite",
            "Resources/Dictionary/LICENSE", "Integrations/Browser/manifest.json",
            "Integrations/Zotero/manifest.json", "Integrations/PDFLayout/server.py",
            "Integrations/PDFLayout/platform_ops.py", "Integrations/PDFLayout/requirements.windows.lock",
            "Integrations/PDFLayout/LICENSE-BabelDOC-AGPL-3.0.txt", "scripts/windows/prepare-pdf.ps1",
            "scripts/windows/prepare-codex.ps1", "docs/INSTALL.Windows.zh-CN.md", "NOTICE.md"}

def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()

def validate_file(path, relative):
    if path.is_symlink() or any(part in IGNORED or part.startswith(".") for part in relative.parts):
        raise ValueError("Unexpected bundle path: " + relative.as_posix())
    if path.name in SECRET_NAMES or path.name.endswith((".secret", "-api-key.txt", ".pfx", ".p12", ".pyc")):
        raise ValueError("Private/generated file: " + relative.as_posix())
    if path.suffix.lower() in {".json", ".txt", ".md", ".ps1", ".py", ".js", ".html"}:
        if any(pattern.search(path.read_bytes()) for pattern in SECRETS):
            raise ValueError("Credential pattern: " + relative.as_posix())

def copy_tree(source, target, suffixes=None):
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in IGNORED or part.startswith(".") for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError("Source link: " + str(path))
        if not path.is_file() or (suffixes is not None and path.suffix not in suffixes):
            continue
        validate_file(path, relative)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)

def manifest(bundle):
    records = []
    for path in sorted(bundle.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(bundle)
        if relative.as_posix() == "package-manifest.json":
            continue
        validate_file(path, relative)
        records.append({"path": relative.as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)})
    if missing := REQUIRED - {entry["path"] for entry in records}:
        raise ValueError("Missing package files: " + repr(sorted(missing)))
    result = {"schemaVersion": 1, "version": VERSION, "platform": "win-x64", "files": records,
              "containsCredentials": False, "desktopUserAcceptance": "not performed"}
    (bundle / "package-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result

def check(bundle, installed=False):
    expected = json.loads((bundle / "package-manifest.json").read_text(encoding="utf-8"))
    ignored = {"package-manifest.json"} | ({"Uninstall.exe"} if installed else set())
    actual = {p.relative_to(bundle).as_posix(): p for p in bundle.rglob("*") if p.is_file() and p.relative_to(bundle).as_posix() not in ignored}
    if len(expected["files"]) != len({entry["path"] for entry in expected["files"]}):
        raise ValueError("Duplicate manifest path")
    if set(actual) != {entry["path"] for entry in expected["files"]}:
        raise ValueError("Package member set differs")
    for entry in expected["files"]:
        path = actual[entry["path"]]
        validate_file(path, Path(entry["path"]))
        if path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
            raise ValueError("Package hash differs: " + entry["path"])
    if not REQUIRED <= set(actual):
        raise ValueError("Required files missing")
    return {"status": "PASS", "files": len(actual), "bytes": sum(p.stat().st_size for p in actual.values())}

def assemble(published, output, root=ROOT):
    if output.exists():
        raise ValueError("Use a fresh package directory")
    output.mkdir(parents=True)
    copy_tree(published, output)
    for name in ["Browser", "Zotero"]:
        copy_tree(root / "Integrations" / name, output / "Integrations" / name,
                  {".json", ".js", ".mjs", ".css", ".html", ".svg", ".png", ".ftl", ".dtd", ".properties"})
    copy_tree(root / "Integrations/PDFLayout", output / "Integrations/PDFLayout", {".py", ".lock", ".txt", ".json", ".in"})
    copy_tree(root / "Resources/Dictionary", output / "Resources/Dictionary")
    copy_tree(root / "Resources/Distribution", output / "Resources/Distribution", {".txt", ".json"})
    for name in ["prepare-codex.ps1", "prepare-pdf.ps1", "toolchain.json"]:
        destination = output / "scripts/windows" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / "scripts/windows" / name, destination)
    for name in ["INSTALL.Windows.zh-CN.md", "TRANSLATION-BACKENDS.zh-CN.md"]:
        destination = output / "docs" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / "docs" / name, destination)
    shutil.copy2(root / "NOTICE.md", output / "NOTICE.md")
    shutil.copy2(root / "docs/INSTALL.Windows.zh-CN.md", output / "安装与配置说明.txt")
    manifest(output)
    return check(output)

def write_nsis_uninstall(bundle, destination):
    lines = []
    paths = sorted((p.relative_to(bundle) for p in bundle.rglob("*") if p.is_file()), reverse=True)
    for path in paths:
        safe = str(path).replace("/", "\\").replace("$", "$$").replace('"', '$\\"')
        lines.append('Delete "$INSTDIR\\' + safe + '"')
    directories = sorted((p.relative_to(bundle) for p in bundle.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True)
    for path in directories:
        safe = str(path).replace("/", "\\").replace("$", "$$").replace('"', '$\\"')
        lines.append('RMDir "$INSTDIR\\' + safe + '"')
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--published", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", type=Path)
    parser.add_argument("--nsis-uninstall", type=Path)
    parser.add_argument("--installed", action="store_true")
    args = parser.parse_args()
    if args.check:
        result = check(args.check, installed=args.installed)
    elif args.published and args.output:
        result = assemble(args.published, args.output)
    else:
        parser.error("Use --check, or --published and --output")
    if args.nsis_uninstall:
        write_nsis_uninstall(args.check or args.output, args.nsis_uninstall)
    print(json.dumps(result))
