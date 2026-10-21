#!/bin/bash
set -euo pipefail
task_here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
task_app=""
finish() {
  task_status=$?
  if [[ $task_status -ne 0 ]]; then printf '\nPDF 组件准备没有完成。请检查上面的提示，再双击重试；已有译本不受影响。\n'; fi
  if [[ -t 0 ]]; then read -r -p '按回车关闭此窗口。' task_answer || true; fi
}
trap finish EXIT
for task_candidate in "$task_here/Ask for GPT.app" "/Applications/Ask for GPT.app" "$HOME/Applications/Ask for GPT.app"; do
  if [[ -f "$task_candidate/Contents/Resources/PDFLayout/install-runtime" ]]; then
    task_app="$task_candidate"
    break
  fi
done
if [[ -z "$task_app" ]]; then
  printf '请先把 Ask for GPT.app 拖入“应用程序”，再运行这个配置文件。\n' >&2
  exit 1
fi
printf '正在准备 PDF 翻译支持。首次需要联网下载 Python、预编译依赖、字体和排版模型。\n'
printf '无需 Xcode、Homebrew 或自行编译；请保持窗口打开。\n\n'
/bin/sh "$task_app/Contents/Resources/PDFLayout/install-runtime"
printf '\nPDF 支持已准备好。启动 Ask for GPT，再到 Zotero 安装插件即可开始使用。\n'
