# Windows Reading Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a downloadable Windows x64 reading assistant installer and portable ZIP, with honest preview validation boundaries.

**Architecture:** A WPF desktop host calls a pure .NET reading core. The core owns the authenticated loopback listener, dictionary and configurable translation providers, plus a console JSONL helper used by the existing PDF engine. Shared Python and Zotero code receive platform adapters; macOS application sources remain unchanged.

**Tech Stack:** C#/.NET 10/WPF, Python 3.12/BabelDOC 0.6.4, existing JavaScript reader integrations, NSIS, standard public GitHub Windows runner.

**Spec:** `docs/superpowers/specs/2026-10-22-windows-reading-design.md`

## Global Constraints

- User approved the reading scope and instructed that it work on Windows; proceed using engineering discretion without further design confirmations.
- Work only in this isolated public-source checkout, branch `codex/windows-reading-preview`; source baseline `fe54555`.
- Do not install/modify the user's macOS app, Zotero library or credentials. No paid services, live translation calls or paid runners.
- Windows 11 x64 primary, Windows 10 22H2 x64 compatibility target; CI builds are not client-desktop acceptance.
- Preserve current loopback protocol, original PDFs, cached outputs and upstream licenses. Never weaken authentication for portability.
- Publish a separately identified Windows preview, leaving macOS v1.0.85 assets/tag untouched.

## Review Focus

- Unicode/spaced executable and data paths must work without shell interpolation.
- Invalid token, Origin, Host, oversize input and bad provider settings must fail safely without credential logs.
- UIA password controls and clipboard race conditions must not expose text or replace newer clipboard content.
- Cancelling a PDF job/app must reclaim owned descendants without killing unrelated processes.
- An installer build and mocked provider pass must not be described as live provider or Windows desktop validation.

## Task 1: Windows reading core and JSONL translation helper

**Files:** `Platforms/Windows/AskGPT.Windows.Core/**`, `Platforms/Windows/AskGPT.Translate/**`, `Platforms/Windows/AskGPT.Windows.Core.Tests/**`.

**Interfaces:** namespace `AskGPT.Windows.Core`. `AppSettings` with `Provider`, `CliPath`, `Model`, `Endpoint`, `ApiKeyFile`, `TranslationConfigurationPath`, `SourceLanguage`, `TargetLanguage`, `AutomaticSelection`, `HotKeyModifiers`, `HotKeyKey`. Static `AppPaths.DataDirectory` uses roaming AppData/AskGPTReader and `BundleDirectory` uses the executable directory. `SettingsStore.Load()` loads defaults or validated settings. `ReaderRuntime.StartAsync(CancellationToken)` returns an initialized runtime; exposes `Settings`, `StatusText`, `PdfReady`, `TranslateAsync(text, source, target, CancellationToken)`, `LookupAsync(word, CancellationToken)`, `UpdateSettingsAsync(settings, CancellationToken)`, `ExportIntegrationsAsync(targetDirectory, CancellationToken)`, `StartPdfAsync(CancellationToken)` and `IAsyncDisposable`. `LookupResult` exposes `Word`, `Phonetic`, `Translation`, `Definition` strings. JSON settings are camelCase.

- [x] Add failing meaningful tests for provider parsing, bounded translation, dictionary, auth, cancellation and configuration isolation.
- [x] Implement core, 43792 listener, safe settings/connection files, owned PDF lifecycle and integration export. External configuration uses the existing JSON provider schema.
- [x] Implement console helper flags `--gpt-batch`, `--gpt-align`, `--gpt-phrase-align`, `--gpt-selection-align`, preserving the Python JSONL contract and existing validation expectations.
- [ ] Run automated tests using only fake providers; send code to independent review and fix blocking findings.

## Task 2: Windows desktop selection and floating reader

**Files:** `Platforms/Windows/AskGPT.Windows/**`.

**Interfaces:** consumes Task 1's public core contract; no duplicate token/server implementation. Main output is `AskGPT.Windows.exe` (self-contained win-x64 publish). Bundle paths are `Integrations/*`, `Resources/Dictionary/*`, `scripts/windows/*` alongside executable.

- [x] Write platform-policy tests where practical for bounded selection, password exclusion and clipboard restore rules.
- [x] Implement settings window, tray, editable hotkey, explicit selection capture via UIA and bounded clipboard fallback, translation/lookup floating window and cancellation. Automatic selection is opt-in.
- [x] Wire component preparation, CLI login help, PDF status/start, integration export and source-grounded install help; explain missing configuration plainly.
- [ ] Compile on Windows, exercise deterministic UI startup/shutdown and record the absence of desktop-user acceptance.

## Task 3: PDF portability and Zotero connection path

**Files:** `Integrations/PDFLayout/platform_ops.py`, affected Python engine files/tests, `Integrations/Zotero/content/inline.js`, relevant Zotero tests, `scripts/windows/prepare-pdf.ps1`.

**Interfaces:** roaming `%APPDATA%/AskGPTReader/inline-connection.json`; Python cache `%APPDATA%/AskGPTReader/PDFLayout`; runtime `runtime/Scripts/python.exe`; bundled helper `AskGPT.Translate.exe`; preserve Python server CLI and ports. Linux/macOS branches preserve existing behavior. Windows protected files use ACL, reject reparse points, and locking/pipe/process operations must use Windows-capable mechanisms.

- [x] Add failing tests for the platform branch, path construction and lock/cleanup policy.
- [x] Implement platform primitives and replace POSIX-only call sites, including worker pipes and batch permits.
- [x] Adapt Zotero's connection discovery/security checks; run existing JS suites.
- [x] Add fixed-version Windows runtime preparation and Windows dependency lock with hashes, verified using Windows binary wheels; no source compilation.
- [ ] Run Python tests locally and on Windows; independently review portability and security behavior.

## Task 4: Packaging, CI, integration and release

**Files:** `.github/workflows/windows-preview.yml`, `scripts/windows/build.ps1`, `scripts/windows/installer.nsi`, runtime/CLI preparation and package checks, Windows install guide, README links and manifest allowlist.

- [x] Pin build tools/dependencies and prepare a standard Windows runner workflow with read-only permissions, bounded artifact storage and no model credentials.
- [ ] Publish self-contained app/helper, dictionary, integrations, guides and licenses; produce user-level NSIS EXE, ZIP and SHA256 manifest.
- [ ] Run Windows compile/core/protocol/Python/JavaScript/package checks; repair real failures and inspect the final artifact contents.
- [ ] Obtain whole-branch review; resolve important findings, then publish the preview through the already authorized GitHub repository/release workflow.
- [ ] Verify remote source commit and download asset hashes; record exact checks, limits and local artifact paths, and keep macOS release unchanged.
