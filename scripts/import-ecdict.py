#!/usr/bin/env python3
"""Build the shipped, read-only single-word dictionary from pinned upstream data.

No network, model, user database or application preference access. Download the
two fixed Git blobs separately, then pass their local paths. CSV stays in work/.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import unicodedata

COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_BLOB = "c4ade63ea08cf39d9c3475e96929036d64d94c94"
LICENSE_BLOB = "594da8a1009c6a9b96d0fe8d1689aa192cf187fe"
REPOSITORY = "https://github.com/skywind3000/ECDICT"
APPLICATION_ID = 0x41574C44


def checked_blob(path, expected):
    data = path.read_bytes()
    blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if blob != expected:
        raise ValueError(f"Pinned upstream Git blob mismatch: {path.name}")
    return data


def single_word(word):
    if not word or len(word) > 96 or any(c.isspace() for c in word):
        return False
    previous_letter = False
    for index, char in enumerate(word):
        value = ord(char)
        letter = char.isalpha() and (65 <= value <= 90 or 97 <= value <= 122
                                    or 0xC0 <= value <= 0x24F or 0x370 <= value <= 0x3FF)
        if letter:
            previous_letter = True
            continue
        if char not in "'-." or not previous_letter:
            return False
        previous_letter = False
        if index == len(word) - 1 and char != ".":
            return False
    return previous_letter or word.endswith(".")


def canonical_word(value):
    return unicodedata.normalize("NFC", value.strip()).replace("’", "'").replace("‐", "-").replace("‑", "-")


def build(source, license_path, output):
    csv_bytes = checked_blob(source, SOURCE_BLOB)
    license_bytes = checked_blob(license_path, LICENSE_BLOB)
    if not license_bytes.startswith(b"MIT License\n"):
        raise ValueError("Unexpected pinned license")
    output.mkdir(parents=True, exist_ok=True)
    database = output / "words.sqlite"
    if database.exists():
        raise FileExistsError("Refusing to replace an existing dictionary; select a new output directory")
    connection = sqlite3.connect(database)
    try:
        connection.executescript(f"""
            PRAGMA page_size=4096;
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            PRAGMA application_id={APPLICATION_ID};
            PRAGMA user_version=1;
            CREATE TABLE entries(word TEXT PRIMARY KEY COLLATE BINARY,
                phonetic TEXT NOT NULL, translation TEXT NOT NULL, pos TEXT NOT NULL) WITHOUT ROWID;
            CREATE TABLE forms(form TEXT COLLATE NOCASE NOT NULL, headword TEXT NOT NULL,
                PRIMARY KEY(form,headword)) WITHOUT ROWID;
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        """)
        source_rows = accepted = skipped = aliases = 0
        pending_forms = []
        csv.field_size_limit(2_000_000)
        with source.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not {"word", "phonetic", "translation", "pos", "exchange"}.issubset(reader.fieldnames or []):
                raise ValueError("Unexpected upstream CSV schema")
            for row in reader:
                source_rows += 1
                word = canonical_word(row["word"] or "")
                translation = (row["translation"] or "").strip()
                if not single_word(word) or not translation or len(translation.encode()) > 100_000:
                    skipped += 1
                    continue
                previous = connection.total_changes
                connection.execute("INSERT OR IGNORE INTO entries VALUES(?,?,?,?)",
                                   (word, (row["phonetic"] or "").strip(), translation, (row["pos"] or "").strip()))
                accepted += connection.total_changes - previous
                # Only the upstream exchange table establishes a lemma relation.
                # No suffix stripping, fuzzy matching, concatenation or AI guess.
                for item in (row["exchange"] or "").split("/"):
                    kind, separator, value = item.partition(":")
                    if not separator or kind not in {"0", "p", "d", "i", "3", "s", "r", "t"}:
                        continue
                    for variant in value.split(","):
                        variant = canonical_word(variant)
                        if not single_word(variant) or variant == word:
                            continue
                        pending_forms.append((word, variant) if kind == "0" else (variant, word))
        connection.execute("CREATE INDEX entries_casefold ON entries(word COLLATE NOCASE)")
        connection.executemany("INSERT OR IGNORE INTO forms SELECT ?,? WHERE EXISTS(SELECT 1 FROM entries WHERE word=?)",
                               ((form, headword, headword) for form, headword in pending_forms))
        aliases = connection.execute("SELECT COUNT(*) FROM forms").fetchone()[0]
        metadata = {"schema": "1", "source_commit": COMMIT, "source_blob": SOURCE_BLOB,
                    "source_url": f"{REPOSITORY}/blob/{COMMIT}/ecdict.csv", "license": "MIT",
                    "entries": str(accepted), "forms": str(aliases)}
        connection.executemany("INSERT INTO metadata VALUES(?,?)", metadata.items())
        connection.commit()
        connection.execute("VACUUM")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Dictionary integrity check failed")
    finally:
        connection.close()
    shutil.copyfile(license_path, output / "LICENSE")
    provenance = {"repository": REPOSITORY, "commit": COMMIT, "license": "MIT",
                  "generator": {"file": "scripts/import-ecdict.py", "version": 1, "sqlite_version": sqlite3.sqlite_version},
                  "source": {"name": "ecdict.csv", "git_blob": SOURCE_BLOB,
                             "sha256": hashlib.sha256(csv_bytes).hexdigest(), "bytes": len(csv_bytes)},
                  "license_file": {"git_blob": LICENSE_BLOB, "sha256": hashlib.sha256(license_bytes).hexdigest()},
                  "database": {"file": "words.sqlite", "schema": 1, "application_id": APPLICATION_ID,
                               "bytes": database.stat().st_size,
                               "sha256": hashlib.sha256(database.read_bytes()).hexdigest()},
                  "rows": {"source": source_rows, "entries": accepted, "skipped": skipped, "forms": aliases},
                  "transformation": "English single words/acronyms/hyphenated words only; preserve Chinese translations, phonetic and explicit POS; aliases only from upstream exchange; remove English definition/frequency/audio/detail fields"}
    (output / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"entries": accepted, "forms": aliases, "bytes": database.stat().st_size}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-csv", type=Path, required=True)
    parser.add_argument("--license", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    build(args.source_csv, args.license, args.output_dir)
