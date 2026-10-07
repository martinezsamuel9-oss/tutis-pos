@echo off
rem ===========================================================================
rem  TUTI'S - Abre la caja en modo kiosko
rem
rem  Copiar este archivo a la carpeta de inicio de Windows para que la caja
rem  abra sola al encender la computadora (ver caja\LEEME.md).
rem
rem  --kiosk           pantalla completa, sin barra de direcciones ni pestanas
rem  --kiosk-printing  el comprobante se imprime directo en la impresora
rem                    predeterminada, sin la ventana de vista previa
rem ===========================================================================
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
start "" "%CHROME%" --kiosk "https://tutis.slabblu.com" --kiosk-printing --no-first-run --disable-pinch --overscroll-history-navigation=0
