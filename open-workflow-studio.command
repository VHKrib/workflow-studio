#!/bin/bash
# 双击启动工作流开发平台（本脚本所在目录就是仓库根目录）
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron . --remote-debugging-port="${CDP_PORT:-9222}"
