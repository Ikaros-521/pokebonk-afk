@echo off
rem ============================================================
rem  PokeBonk 后台挂机专用 Chrome 启动器
rem  使用独立配置目录，与日常浏览器互不影响。
rem  参数作用：
rem   --disable-backgrounding-occluded-windows  窗口被完全遮挡时不再冻结渲染
rem   --disable-renderer-backgrounding          后台标签页不降级
rem   --disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion
rem                                             关闭定时器限流与窗口遮挡检测
rem  说明：Chrome 137 起官方版已忽略 --load-extension，无法用命令行自动装扩展，
rem        第一次启动后请按窗口提示手动加载一次扩展（之后永久保留）。
rem ============================================================
rem  维护注意：本文件必须保存为 ANSI(GBK) 编码 + CRLF 换行；
rem  rem 注释行里不要写百分号变量（中文注释行展开变量会让 cmd 读行错位、整段乱套）。
rem ============================================================
setlocal
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo [错误] 没有找到 Chrome，请检查本脚本里的三个路径，或手动改成你的 chrome.exe 位置。
  pause
  exit /b 1
)

start "" "%CHROME%" ^
  --user-data-dir="%LocalAppData%\Chrome-PokeBonk-AFK" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion ^
  "https://pokebonk.com/"

echo.
echo 已用独立窗口启动 PokeBonk。
echo.
if not exist "%~dp0extension\manifest.json" echo [提示] 没找到 %~dp0extension\manifest.json ，扩展可能不完整，安装步骤第 3 步会失败。
echo 【仅第一次需要】这个窗口用的是独立配置，不带日常浏览器的扩展，请手动加载一次：
echo   1. 在新开的 Chrome 窗口地址栏输入 chrome://extensions/ 并回车
echo   2. 打开右上角"开发者模式"开关
echo   3. 点"加载已解压的扩展程序"，选择本目录下的 extension 文件夹：
echo      %~dp0extension
echo   加载一次后永久保留，以后直接双击本脚本即可。
echo.
pause
