@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动工作流开发平台...
if not exist node_modules (
  echo 第一次运行，先装依赖（需要 Node.js 18+）...
  call npm install || goto :fail
)
call npm start
goto :eof

:fail
echo.
echo 依赖没装成功，检查一下 Node.js 是否已安装（命令行运行 node -v 应该能看到版本号）。
pause
