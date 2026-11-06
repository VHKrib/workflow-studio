#!/bin/bash
# 双击启动 TC 工作流台
cd "<REPO>" || exit 1
exec ./node_modules/.bin/electron . --remote-debugging-port=9222
