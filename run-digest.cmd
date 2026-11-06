@echo off
REM Wrapper that Task Scheduler runs once a day.
REM It changes into the tool's folder, runs the digest (which reads .env for
REM SMTP credentials), writes digest.html, and appends output to digest.log.

cd /d "%~dp0"

echo ===== %DATE% %TIME% ===== >> digest.log
node digest.js --html >> digest.log 2>&1
echo. >> digest.log
