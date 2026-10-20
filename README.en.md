<div align="center">

**[中文](README.md) · English**

<img src="Resources/AppIcon.png" width="96" alt="Ask for GPT icon">

# Ask for GPT

**Translate, ask, read side by side, and revise in your existing workspace.**

[![macOS](https://img.shields.io/badge/platform-macOS-28527A)](Package.swift)
[![Swift](https://img.shields.io/badge/Swift-6-C97864)](Package.swift)
[![Chrome](https://img.shields.io/badge/Chrome-1.1.2-4F8F8A)](Integrations/Browser/manifest.json)
[![Zotero](https://img.shields.io/badge/Zotero-0.3.24-7D719B)](Integrations/Zotero/manifest.json)

[Chinese handbook](docs/HANDBOOK.zh-CN.md) · [Interface gallery](docs/GALLERY.md) · [Download source](https://github.com/Woyekun-cell/Ask-for-GPT/archive/refs/heads/main.zip) · [Issues](https://github.com/Woyekun-cell/Ask-for-GPT/issues)

</div>

Ask for GPT is a macOS companion for reading English papers and revising academic writing. Look up a word, translate a passage, ask follow-up questions, or read a translated PDF in a floating panel, Chrome, or Zotero. Writing suggestions show the proposed change before you choose to apply it.

The app uses Swift, AppKit, and SwiftUI. English words can use an offline dictionary; passage translation can use Apple's on-device translation. GPT refinement, explanations, questions, and PDF translation use your own signed-in Codex CLI session.

## Features

| Workflow | Capabilities |
|---|---|
| Word lookup | About 400,000 offline entries, pronunciation, parts of speech, meanings, and inflected forms |
| Selected text | EN→Chinese, Chinese→EN, automatic direction, local translation, GPT refinement, and explanations |
| Questions | Passage context, streamed replies, follow-up questions, web search, and source links |
| Web reading | Paragraph-by-paragraph bilingual text in Chrome, with restoration of the original page |
| PDF reading | Page or document translation, preserved page layout, original/translated/dual views, reusable completed outputs |
| Zotero | Native reader integration, sidebar, linked scrolling, size synchronization, phrase mapping, and native annotation colors |
| Word | Spelling and GPT revision suggestions, minimal/clarity modes, US/UK spelling, user-controlled replacement |
| WPS | Sidebar and explicit checking adapter; host-specific limitations are listed below |

## Interface tour

These native UI demonstrations use project-authored sample text. Rendering details and scope are documented in the [gallery](docs/GALLERY.md).

### Translation beside your text

![Translation panel](docs/images/translation.png)

A compact panel brings together translation direction, result colors, and a question entry point.

### Bilingual reading

![Bilingual reading](docs/images/bilingual-reading.jpg)

This sample shows the paragraph reading view. Chrome supports inline translations; PDF translation uses a separate layout-preserving workflow, including original, translated, and dual views in Zotero.

### Review a change before applying it

![Writing suggestion](docs/images/writing.png)

The suggestion card shows the original text and replacement, with apply, ignore, and dictionary actions. Real Word replacement and formatting need verification in the intended host version.

### Settings in one place

![Settings](docs/images/settings.png)

Configure the CLI path, question model, reasoning effort, automatic selection translation, and shortcut. Available models depend on your account and CLI environment.

## Build and use

This is a **source distribution**, including the app, integrations, tests, dictionary, and packaging scripts. PDF Python dependencies, models, and fonts are prepared separately.

| Component | Requirements |
|---|---|
| App | Swift 6; package deployment target macOS 13; development scripts prefer the macOS 26.5 SDK |
| Apple translation | macOS 26+ and installed language packs |
| GPT | Codex CLI ≥0.162.1, signed in with ChatGPT; account model access and usage limits apply |
| PDF | Python 3.12 and uv; pinned BabelDOC 0.6.4 dependencies; current lock targets Apple Silicon macOS |
| Chrome | Chrome 106+; file URL permission for local PDFs |
| Zotero | Zotero 9.x |
| Writing bridge | macOS 15+, separate local HTTPS and add-in preparation |
| WPS writing | Explicit sidebar checking; no inline colored underlines; Mac content events, replacement, and undo await live verification |

```bash
git clone https://github.com/Woyekun-cell/Ask-for-GPT.git
cd Ask-for-GPT
python3 scripts/app-signing prepare
./scripts/build-app
python3 scripts/install-app
```

Create and retain your own local signing identity. See the [handbook](docs/HANDBOOK.zh-CN.md) for prerequisites, PDF runtime setup, extension installation, and writing add-ins. This snapshot has not been validated through a complete installation on a fresh Mac.

| Shortcut | Action |
|---|---|
| `⌥D` | Translate selection; configurable |
| `⌥X` | Ask about selection |
| `⌥⇧X` | Translate or restore page |
| `⌘,` | Settings |
| `Enter` / `Shift+Enter` | Send / newline in chat |

## Data and scope

Dictionary lookup and Apple translation run locally. GPT features send the corresponding extracted text through the configured Codex session; PDF layout processing stays local. Original PDFs are preserved, with derived translations cached by source hash, page range, and language direction. Up to two documents can run independently, with cancellation per task.

The PDF pipeline requires a text layer. Scanned pages and text embedded in images need a separate OCR workflow. Exact mapping of complex vertical figure text, physical modifier gestures, and host-specific replacement behavior need environment-specific checks.

## Source and checks

`Sources/` contains the app and core; `Integrations/` contains Chrome, Zotero, Word/WPS, and the PDF engine; `Resources/` contains icons, the dictionary, and writing rules. `Tests/` and `scripts/` provide core tests, packaging, and checks.

Run `./scripts/test` for Swift core tests. The [handbook](docs/HANDBOOK.zh-CN.md) lists JavaScript and Python checks. The public [file manifest](docs/release-manifest.json) records SHA-256 values:

```bash
python3 scripts/prepare-github-release --check .
```

File audits, UI rendering, algorithm tests, and live host behavior are separate forms of evidence. Interface illustrations do not certify end-to-end host operations or new-machine installation.

## Sources and feedback

The offline dictionary derives from a pinned [ECDICT revision](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b), with its MIT license and provenance retained. PDF integration uses [BabelDOC 0.6.4](https://github.com/funstory-ai/BabelDOC/tree/v0.6.4), with its AGPL-3.0 license, lock file, and integration sources. See [NOTICE](NOTICE.md) for component-specific notices. This upload does not assign a new unified license to first-party code.

Report issues with macOS, host, and extension versions, reproduction steps, and screenshots free of private content.
