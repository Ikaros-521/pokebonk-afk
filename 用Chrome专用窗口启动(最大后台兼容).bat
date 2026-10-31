@echo off
rem ============================================================
rem  PokeBonk 后台挂机专用 Chrome 启动器
rem  使用独立配置目录，不影响你日常的浏览器。
rem  参数作用：
rem   --disable-backgrounding-occluded-windows  窗口被完全遮挡时不再冻结渲染
rem   --disable-renderer-backgrounding          后台标签页不降级
rem   --disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion
rem                                             关闭定时器限流与窗口遮挡检测
rem ============================================================
setlocal
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if "%CHROME%"=="" (
  echo 未找到 Chrome，请手动把下面的路径改成你的 chrome.exe 后重试本脚本。
  pause
  exit /b 1
)

start "" "%CHROME%" ^
  --user-data-dir="%LocalAppData%\Chrome-PokeBonk-AFK" ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion ^
  "https://pokebonk.com/"

echo 已用独立窗口启动 PokéBonk。
echo 提示：这个独立配置里第一次需要重新加载一次挂机扩展（chrome://extensions -^> 加载已解压 -^> 选择 extension 文件夹）。
