@echo off
setlocal enabledelayedexpansion
cd /d "C:\Users\Zoe\dc-inside-bot"
call npm start >> C:\Users\Zoe\dc-inside-bot\bot-log.txt 2>&1
exit /b %errorlevel%
