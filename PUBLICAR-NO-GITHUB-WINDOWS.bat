@echo off
setlocal
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 (
 echo ERRO: instale Git for Windows antes de continuar.
 echo https://git-scm.com/downloads/win
 pause
 exit /b 1
)
if not exist "package.json" (
 echo ERRO: execute este BAT dentro da pasta extraida do ZIP.
 pause
 exit /b 1
)
echo ATENCAO: crie ANTES o repositorio PUBLICO e VAZIO rykellmy31-star/CR-IA no GitHub.
echo Nenhum arquivo .env ou backup deve estar nesta pasta.
set /p CONFIRM=Digite PUBLICAR para enviar os arquivos: 
if not "%CONFIRM%"=="PUBLICAR" exit /b 0
if not exist .git git init
if errorlevel 1 goto :failure
git add .
if errorlevel 1 goto :failure
git diff --cached --name-only | findstr /R /C:"^\.env$" /C:"\.key$" /C:"\.dump$" >nul
if not errorlevel 1 (
 echo ERRO: arquivos sensiveis na selecao. Remova-os antes de publicar.
 exit /b 1
)
git commit -m "CR IA: fonte e instalador GitHub" 2>nul
REM Reexecucao e possivel caso nenhum arquivo tenha mudado.
git branch -M main
(git remote get-url origin >nul 2>nul) && (git remote set-url origin https://github.com/rykellmy31-star/CR-IA.git) || (git remote add origin https://github.com/rykellmy31-star/CR-IA.git)
git push -u origin main
if errorlevel 1 goto :failure
echo.
echo SUCESSO: codigo enviado ao GitHub. Confira visibilidade e segredos.
pause
exit /b 0
:failure
echo FALHA: nao foi possivel publicar. Confira autenticacao e repo vazio.
pause
exit /b 1
