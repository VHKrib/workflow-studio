#!/usr/bin/env bash
# 把「工作流开发平台」推到 GitHub。登录一次之后，这条命令就够：
#
#   tools/publish-github.sh                     # 默认建私有仓库 workflow-studio
#   tools/publish-github.sh my-repo public      # 指定名字 / 公开
#   tools/publish-github.sh --push-only         # 只是把新提交推上去
#
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="workflow-studio"
VIS="private"
MODE="create"
case "${1:-}" in
  --push-only) MODE="push" ;;
  "") ;;
  *) REPO="$1"; VIS="${2:-private}" ;;
esac

command -v gh >/dev/null || { echo "缺 GitHub CLI：brew install gh"; exit 1; }

if [ "$MODE" = "push" ]; then
  git push
  gh repo view --web >/dev/null 2>&1 || true
  echo "已推送：$(git remote get-url origin)"
  exit 0
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "还没登录 GitHub。先跑一次（浏览器授权，30 秒）："
  echo "    gh auth login --web"
  exit 1
fi

# 提交身份跟 GitHub 账号对齐，别让提交挂在 localhost 上
WHO="$(gh api user --jq .login)"
NAME="$(gh api user --jq '.name // .login')"
EMAIL="$(gh api user --jq '.email // empty')"
git config user.name "$NAME"
[ -n "$EMAIL" ] && git config user.email "$EMAIL"

if git remote get-url origin >/dev/null 2>&1; then
  echo "已有 origin：$(git remote get-url origin)（改用 --push-only 推送）"
  exit 1
fi

gh repo create "$REPO" --"$VIS" --source=. --remote=origin \
  --description "工作流开发平台：把业务链路拆成输入/加工/输出卡片，一条流程指派一个 agent，卡片能问 agent、让 agent 给下一步候选" \
  --push

echo
echo "搞定： https://github.com/$WHO/$REPO"
