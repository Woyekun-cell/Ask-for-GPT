"""Boundaries shared by the loopback PDF service and its offline worker."""
from __future__ import annotations

from collections import Counter
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Callable
import platform_ops as platform

BABELDOC_VERSION = "0.6.4"
MAX_PDF_BYTES = 150 * 1024 * 1024
MAX_OUTPUT_BYTES = 450 * 1024 * 1024
MAX_PAGES = 2000
PORT = 43795
PLACEHOLDER = re.compile(r"\{v\d+\}|</?b\d+>|<style\s+id=['\"]\d+['\"]\s*>|</style>")


class ProtocolFailure(Exception):
    """A public error code only: never put input text or filesystem paths here."""


def private_directory(path: Path) -> Path:
    try: return platform.private_directory(path)
    except (OSError, ValueError): raise ProtocolFailure("unsafe_cache_directory") from None


def load_connection(path: Path) -> tuple[str, str | None]:
    try:
        descriptor = platform.secure_open(path, os.O_RDONLY)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            platform.validate_file(handle.fileno())
            if info.st_size > 8192:
                raise ProtocolFailure("invalid_configuration")
            config = json.load(handle)
        token = config["token"]
        if (config.get("version") != 1
                or config.get("endpoint") != "http://127.0.0.1:43792"
                or not isinstance(token, str) or not 32 <= len(token) <= 256
                or any(not 33 <= ord(char) <= 126 for char in token)):
            raise ProtocolFailure("invalid_configuration")
        origin = None
        if "extensionID" in config:
            identity = config["extensionID"]
            if not isinstance(identity, str) or not re.fullmatch(r"[a-p]{32}", identity):
                raise ProtocolFailure("invalid_configuration")
            origin = "chrome-extension://" + identity
        return token, origin
    except (OSError, ValueError, TypeError, KeyError):
        raise ProtocolFailure("invalid_configuration") from None


def load_token(path: Path) -> str:
    return load_connection(path)[0]


def parse_pages(value: str, page_count: int) -> list[int]:
    if not 1 <= page_count <= MAX_PAGES:
        raise ProtocolFailure("page_limit_exceeded")
    if value == "all":
        return list(range(page_count))
    if not isinstance(value, str) or len(value) > 16000 or not value:
        raise ProtocolFailure("invalid_pages")
    result: set[int] = set()
    for part in value.split(","):
        match = re.fullmatch(r"([1-9]\d*)(?:-([1-9]\d*))?", part.strip())
        if not match:
            raise ProtocolFailure("invalid_pages")
        first, last = int(match[1]), int(match[2] or match[1])
        if first > last or last > page_count:
            raise ProtocolFailure("invalid_pages")
        result.update(range(first - 1, last))
    return sorted(result)


def placeholders(text: str) -> list[str]:
    return PLACEHOLDER.findall(text)


def split_text(text: str, limit: int = 1800) -> list[str]:
    """Keep every source character, preferring sentence/word boundaries."""
    if limit < 1:
        raise ValueError("invalid_chunk_limit")
    result = []
    while len(text) > limit:
        candidate = text[:limit]
        boundaries = [match.end() for match in re.finditer(r"[.!?。！？;；]\s*|\n+|\s+", candidate)]
        split = next((item for item in reversed(boundaries) if item >= limit // 2), limit)
        # Protect tokens even when a caller uses this function directly.
        for token in PLACEHOLDER.finditer(text):
            if token.start() < split < token.end():
                split = token.start() or token.end()
                break
            if token.start() >= split:
                break
        if split > limit:
            raise ProtocolFailure("oversized_placeholder")
        result.append(text[:split])
        text = text[split:]
    if text:
        result.append(text)
    return result


def translate_protected(text: str, translate: Callable[[str], str]) -> str:
    """Formula/style tokens remain local and are restored in source order."""
    output = []
    position = 0
    for token in list(PLACEHOLDER.finditer(text)) + [None]:
        end = token.start() if token else len(text)
        for piece in split_text(text[position:end]):
            if not piece.strip():
                output.append(piece)
                continue
            translated = translate(piece)
            if not isinstance(translated, str) or not translated.strip():
                raise ProtocolFailure("empty_translation")
            if placeholders(translated):
                raise ProtocolFailure("formula_placeholder_mismatch")
            # Spaces around an isolated inline formula are semantically useful.
            prefix = re.match(r"^\s*", piece)[0]
            suffix = re.search(r"\s*$", piece)[0]
            output.append(prefix + translated.strip() + suffix)
        if token:
            output.append(token.group())
            position = token.end()
    result = "".join(output)
    if Counter(placeholders(result)) != Counter(placeholders(text)):
        raise ProtocolFailure("formula_placeholder_mismatch")
    return result


def install_offline_guard() -> None:
    """Irreversible Python audit hook: PDF workers cannot connect or resolve DNS."""
    def audit(event, args):
        if event in {"socket.connect", "socket.getaddrinfo", "socket.gethostbyname",
                     "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg"}:
            raise PermissionError("pdf_worker_network_disabled")
    sys.addaudithook(audit)
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})


def configure_asset_home(cache_root: Path) -> Path:
    home = private_directory(cache_root / "engine-home")
    private_directory(home / ".cache")
    private_directory(home / ".cache" / "babeldoc")
    if platform.IS_WINDOWS:
        os.environ.setdefault("ASKGPT_ORIGINAL_USERPROFILE", platform.actual_user_home())
        os.environ["USERPROFILE"] = str(home)
    os.environ["HOME"] = str(home)
    os.environ["TIKTOKEN_CACHE_DIR"] = str(home / ".cache" / "babeldoc" / "tiktoken")
    return home / ".cache" / "babeldoc"


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    descriptor = platform.secure_open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
