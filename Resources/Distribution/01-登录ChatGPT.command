#!/bin/bash
# Prepare the unchanged official CLI package; the user completes browser login.
set -euo pipefail
umask 077
task_version=0.163.0
task_archive_sha=b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34
task_here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
task_tools="${ASKGPT_TOOLS_DIR:-$HOME/Library/Application Support/AskGPTReader/Tools}"
task_destination="$task_tools/codex-$task_version"
task_cli="$task_destination/bin/codex"
task_temporary=""
finish() {
  task_status=$?
  if [[ -n "$task_temporary" && -d "$task_temporary" ]]; then /bin/rm -rf "$task_temporary"; fi
  if [[ $task_status -ne 0 ]]; then printf '\n配置没有完成。请检查上面的文件或登录提示，再双击此文件重试。\n'; fi
  if [[ -t 0 ]]; then read -r -p '按回车关闭此窗口。' task_answer || true; fi
}
trap finish EXIT
if [[ "$(/usr/bin/uname -s)" != Darwin || "$(/usr/bin/uname -m)" != arm64 ]]; then
  printf '这个安装包适用于 Apple Silicon Mac（M 系列芯片）。\n' >&2
  exit 1
fi
/bin/mkdir -p "$task_tools"
if [[ ! -x "$task_cli" ]]; then
  task_archive="$task_here/Tools/codex-package-aarch64-apple-darwin.tar.gz"
  if [[ ! -f "$task_archive" || -L "$task_archive" ]]; then
    printf '请从完整 DMG/ZIP 运行此入口，保持旁边的 Tools 文件夹完整。\n' >&2
    exit 1
  fi
  printf '正在校验并准备随包附带的 OpenAI 官方 Codex CLI %s……\n' "$task_version"
  task_actual="$(/usr/bin/shasum -a 256 "$task_archive" | /usr/bin/awk '{print $1}')"
  if [[ "$task_actual" != "$task_archive_sha" ]]; then
    printf 'CLI 文件校验失败，请重新下载安装包；未执行该文件。\n' >&2
    exit 1
  fi
  task_temporary="$(/usr/bin/mktemp -d "$task_tools/.codex-setup.XXXXXX")"
  /bin/mkdir "$task_temporary/package"
  /usr/bin/tar -xzf "$task_archive" -C "$task_temporary/package"
  if [[ ! -f "$task_temporary/package/bin/codex" || -L "$task_temporary/package/bin/codex" ]]; then
    printf '官方压缩包结构与预期不符。\n' >&2
    exit 1
  fi
  if [[ -e "$task_destination" ]]; then
    printf '已有不完整的 CLI 目录，请先保存并移走该目录后重试：%s\n' "$task_destination" >&2
    exit 1
  fi
  /bin/mv "$task_temporary/package" "$task_destination"
fi
"$task_cli" --version
if [[ "${1:-}" == --prepare-only || "${1:-}" == --download-only ]]; then
  printf '官方 CLI 已校验并准备：%s\n' "$task_cli"
  exit 0
fi
printf '\n接下来会打开浏览器，请登录你自己的 ChatGPT 账号。\n'
"$task_cli" login
printf '\n登录完成。请打开 Ask for GPT 设置，把“CLI 路径”改为：\n%s\n' "$task_cli"
printf '%s' "$task_cli" | /usr/bin/pbcopy
printf '路径已复制，可直接粘贴；然后点击“保存并连接”。\n'
