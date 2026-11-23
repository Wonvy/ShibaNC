export const EN_TRANSLATIONS = {
  // Window & App
  "app.windowTitle": "ShibaNC — 3-Axis G-Code Toolpath & Solid Simulation",
  "app.ready": "Ready",
  "app.dropMask": "Release mouse to load .tap / .nc file",
  "app.webgpuHint": "WebGPU Notice: {error}",

  // Topbar — Center Mode & Inspection
  "topbar.mode.solid": "Solid",
  "topbar.mode.solidTip": "Show machined 3D solid workpiece only",
  "topbar.mode.toolpath": "Toolpath",
  "topbar.mode.toolpathTip": "Show 3D toolpath trajectories and stock wireframe only",
  "topbar.mode.both": "Solid + Path",
  "topbar.mode.bothTip": "Overlay 3D toolpath trajectories on machined solid",
  "topbar.section": "Section",
  "topbar.sectionTip": "Toggle live 3D cross-section plane to inspect blind holes and wall thickness",
  "topbar.measure": "Measure",
  "topbar.measureTip": "Probe surface cut depth or click two points to measure 3D distance (Shortcut M)",
  "topbar.quadView": "Quad View",
  "topbar.quadViewTip": "Toggle Blender-style Quad View / Single View (Shortcut Q or Ctrl+Alt+Q)",

  // Topbar — Right Menus (View, G-Code, Export, Language, Theme)
  "topbar.view": "View",
  "topbar.viewTip": "Multi-viewport split layout and scene display options",
  "topbar.view.layoutTitle": "Viewport Layout (Q)",
  "topbar.view.single": "Single",
  "topbar.view.dual": "Split",
  "topbar.view.quad": "Quad",
  "topbar.view.showCutter": "Show 3D Cutter",
  "topbar.view.showFloor": "Show Grid & Axes",
  "topbar.view.showRapids": "Show G0 Rapids",
  "topbar.view.showRapidsDesc": "Display red rapid retract moves in toolpath view",
  "topbar.view.fileAssoc": "Default .nc / .tap Viewer",
  "topbar.view.fileAssocDesc": "Open CNC files directly on double-click",
  "topbar.view.osThumb": "Explorer 3D Thumbnails",
  "topbar.view.osThumbDesc": "Render 3D part previews for file icons",

  "topbar.gcode": "G-Code",
  "topbar.gcodeTip": "Toggle right G-Code inspector panel",

  "topbar.export": "Export",
  "topbar.exportTip": "Export high-resolution PNG render or watertight binary STL mesh",
  "topbar.export.title": "Export Format",
  "topbar.export.pngTitle": "Export HD Render (.png)",
  "topbar.export.pngDesc": "1920×1440 · 4x MSAA studio offscreen render",
  "topbar.export.stlTitle": "Export 3D Mesh (.stl)",
  "topbar.export.stlDesc": "Watertight binary STL mesh for CAD & 3D printing",

  "topbar.langTip": "Switch UI language or import/export custom translation JSON",
  "topbar.lang.menuTitle": "Language",
  "topbar.lang.customSection": "Custom Languages",
  "topbar.lang.import": "Import Language (.json)",
  "topbar.lang.importDesc": "Load a user-translated JSON language pack",
  "topbar.lang.export": "Export Language (.json)",
  "topbar.lang.exportDesc": "Save current language as a translatable template",
  "topbar.lang.removeTip": "Remove custom language pack",

  "topbar.theme.toLight": "Switch to Light Theme",
  "topbar.theme.toDark": "Switch to Dark Theme",

  // Version & Auto-Update
  "update.versionTip": "Version v{ver} · Click to check for updates",
  "update.newBadge": "NEW",
  "update.popoverTitle": "Version & Auto-Update",
  "update.currentVer": "Current Version",
  "update.status.idle": "Up to date (v{ver})",
  "update.status.checking": "Checking for updates...",
  "update.status.available": "New version v{ver} available",
  "update.status.downloading": "Downloading update ({pct}%)...",
  "update.status.installing": "Installing update & restarting...",
  "update.status.upToDate": "You are on the latest version (v{ver})",
  "update.status.needRepo": "Set GitHub repository (owner/repo) to check releases",
  "update.status.error": "Update check failed: {err}",
  "update.checkBtn": "Check for Updates",
  "update.installRestartBtn": "Update & Restart (v{ver})",
  "update.downloadInstallerBtn": "Download Installer (v{ver})",
  "update.viewReleaseBtn": "Release Notes",
  "update.autoCheck": "Auto-check on startup",
  "update.repoLabel": "GitHub Repo",
  "update.repoPlaceholder": "owner/ShibaNC",
  "toast.updateAvailable": "New version v{ver} is available!",
  "toast.upToDate": "ShibaNC v{ver} is already up to date",

  // Left Sidebar Tabs & Parameters
  "sidebar.tab.params": "Machining",
  "sidebar.tab.files": "Files",
  "sidebar.resizeLeftTip": "Drag to resize left panel",
  "sidebar.resizeRightTip": "Drag to resize right panel",

  "params.material": "Material",
  "params.quality": "Quality",
  "params.quality.fast": "Fast",
  "params.quality.hd": "HD",
  "params.quality.ultra": "Ultra",
  "params.resetStockTip": "Reset to auto-inferred stock dimensions",
  "params.dimX": "Length X",
  "params.dimY": "Width Y",
  "params.dimZ": "Height Z",
  "params.origin": "Origin",
  "params.origin.center": "Center",
  "params.origin.centerTip": "Center stock symmetrically around toolpath",
  "params.origin.corner": "Bottom-Left",
  "params.origin.cornerTip": "Align bottom-left stock corner to G-Code (0, 0)",
  "params.datum": "Z Zero",
  "params.datum.top": "Top",
  "params.datum.topTip": "Touch off Z0 at top surface of stock",
  "params.datum.bottom": "Bottom",
  "params.datum.bottomTip": "Touch off Z0 at bottom bed surface",
  "params.cutter": "Cutter",
  "params.resetToolTip": "Reset to auto-inferred cutter geometry",
  "params.diameter": "Diameter D",
  "params.cornerRadius": "Corner R",
  "params.taperAngle": "Taper α",

  // Sidebar Status Bar
  "status.lines": "{count} lines",
  "status.tooltip": "{file} · Stock {x}×{y}×{z}mm · Parsed in {ms}ms",

  // Materials
  "material.dropdownLabel": "Workpiece Material",
  "material.4.name": "Natural Pine Wood",
  "material.4.desc": "Warm timber grain · Woodworking & relief plaques",
  "material.1.name": "Burmese Rosewood",
  "material.1.desc": "Rich hardwood rings · Fine wood carving",
  "material.0.name": "6061 Aluminum",
  "material.0.desc": "Brushed silver metallic · Aerospace & mold milling",
  "material.2.name": "H62 Precision Brass",
  "material.2.desc": "Warm golden reflection · Engravings & stamps",
  "material.3.name": "Imperial Celadon Jade",
  "material.3.desc": "Translucent jadeite · Relief & lapidary art",
  "material.5.name": "Z-Depth Heatmap",
  "material.5.desc": "False-color elevation map · 1mm contour lines",

  // Cutters
  "tool.dropdownLabel": "3-Axis Milling Cutter",
  "tool.diagramTip": "Proportional 2D cutter cross-section",
  "tool.flat_end_mill.name": "Flat End Mill",
  "tool.flat_end_mill.desc": "Sharp 90° walls · Roughing, pockets & contours",
  "tool.ball_nose.name": "Ball Nose End Mill",
  "tool.ball_nose.desc": "Hemispherical tip · 3D surface finishing",
  "tool.tapered_ball_nose.name": "Tapered Ball Nose",
  "tool.tapered_ball_nose.desc": "Fine conical ball tip · 3D wood & jade relief",
  "tool.bull_nose.name": "Bull Nose End Mill",
  "tool.bull_nose.desc": "Corner radius bottom · Mold roughing & fillets",
  "tool.v_bit.name": "V-Bit Engraving Cutter",
  "tool.v_bit.desc": "Sharp conical point · V-carving & chamfering",

  // Stock Diagram
  "stock.diagramTip": "Proportional 3D stock & WCS origin preview (dashed box = toolpath bounds)",
  "stock.outOfBounds": "Warning: Toolpath exceeds current stock XY bounds",

  // File Explorer Pane
  "files.openFile": "Open File",
  "files.openFileTip": "Select one or more .nc / .tap / .gcode / .cnc files",
  "files.openFolder": "Folder",
  "files.openFolderTip": "Scan an entire folder of CNC toolpaths",
  "files.viewSwitchAria": "Switch file view",
  "files.cardViewTip": "3D Preview Card View",
  "files.listViewTip": "Compact List View",
  "files.searchPlaceholder": "Filter toolpath files...",
  "files.clear": "Clear",
  "files.clearTip": "Clear imported file list",
  "files.renderingThumb": "Rendering 3D...",
  "files.renderingShort": "3D Preview...",
  "files.builtinGroup": "Built-in Samples",
  "files.sample.reliefSub": "Lotus Wood Relief · 28,954 lines",
  "files.sample.mechSub": "Bearing Housing Mill · 203 lines",
  "files.dropHint": "Drag & drop .nc / .tap files or folders anywhere",

  // Viewport HUD, Cross-Section, Heatmap & Playback Dock
  "hud.roiBadge": "Micro ROI {um} μm",
  "section.x": "X Section",
  "section.y": "Y Section",
  "section.sliderTip": "Slide cross-section plane position",
  "section.closeTip": "Close 3D cross-section",
  "heatmap.title": "Z-Depth Elevation",
  "heatmap.sub": "1mm Contours",

  "dock.stepBackTip": "Step Back (← step / Hold rewind / Shift+← -10% / J -5%)",
  "dock.playTip": "Play Simulation (Space / K · ←/→ seeks ±5% while playing)",
  "dock.pauseTip": "Pause Simulation (Space / K)",
  "dock.stepFwdTip": "Step Forward (→ step / Hold fast-fwd / Shift+→ +10% / L +5%)",
  "dock.linePrefix": "Ln",
  "dock.lineBtnTip": "Active G-Code line (click to reveal in G-Code panel)",

  // Speed Select
  "speed.triggerTip": "Playback speed (Keys 1–6 or ↑ / ↓)",
  "speed.menuTitle": "Playback Speed · Keys 1–6",
  "speed.1": "Fine Slow",
  "speed.2": "Smooth",
  "speed.5": "Normal",
  "speed.10": "Fast",
  "speed.30": "Rapid",
  "speed.100": "Ultra",

  // ViewCube
  "viewcube.homeTip": "Reset default perspective view (Shortcut F)",
  "viewcube.face.top": "TOP",
  "viewcube.face.bottom": "BOT",
  "viewcube.face.front": "FRONT",
  "viewcube.face.back": "BACK",
  "viewcube.face.right": "RIGHT",
  "viewcube.face.left": "LEFT",
  "viewcube.faceTip": "{face} View (Orthographic)",
  "viewcube.vertexTip": "{x}·{y}·{z} Isometric Vertex (Orthographic)",
  "viewcube.ortho": "Ortho",
  "viewcube.persp": "Persp",
  "viewcube.projTip": "Toggle Orthographic / Perspective projection",

  // Multi-View Overlay
  "mv.customOrtho": "3D · Ortho",
  "mv.customPersp": "3D · Persp",
  "mv.preset.top_xy": "Top · XY",
  "mv.preset.front_xz": "Front · XZ",
  "mv.preset.right_yz": "Right · YZ",
  "mv.preset.left_yz": "Left · YZ",
  "mv.preset.back_xz": "Back · XZ",
  "mv.preset.bottom_xy": "Bottom · XY",
  "mv.preset.iso_ortho": "Isometric · Ortho",
  "mv.preset.persp_3d": "3D Perspective",
  "mv.splitVTip": "Drag to resize left/right panes (double-click to reset)",
  "mv.splitHTip": "Drag to resize top/bottom panes (double-click to reset)",
  "mv.splitCrossTip": "Drag center to resize all 4 panes (double-click to reset)",
  "mv.paneTriggerTip": "Switch viewport camera preset · Double-click to maximize",
  "mv.maximizeTip": "Maximize this viewport",
  "mv.menuTitle": "Viewport Preset",
  "mv.resetFit": "Fit & Reset Sub-View",

  // Measure Overlay
  "measure.hintIdle": "Hover to probe depth, or click any two surface points to measure 3D distance",
  "measure.hintPending": "Click second point on model to finish (Esc to cancel, drag to orbit)",
  "measure.clear": "Clear ({count})",
  "measure.deleteTip": "Delete measurement",
  "measure.horiz": "XY {val}",
  "measure.depth": "Depth",

  // Right G-Code Panel
  "gcode.title": "G-Code",
  "gcode.lineBadge": "Ln {cur} / {total}",
  "gcode.centerTip": "Click to center active line",
  "gcode.locateTip": "Scroll to active line",
  "gcode.closeTip": "Close G-Code panel",

  // Dialogs & Toasts
  "dialog.filterGcode": "CNC Toolpath (.tap, .nc, .gcode, .cnc)",
  "dialog.openFolderTitle": "Select Folder with .tap / .nc Toolpaths",
  "dialog.filterPng": "PNG Image (.png)",
  "dialog.filterStl": "Binary STL 3D Mesh (.stl)",
  "dialog.filterJson": "JSON Language Pack (.json)",
  "dialog.exportPreviewSuffix": "_preview.png",

  "toast.sampleError": "Failed to load sample: {err}",
  "toast.loadedFile": "Loaded {name}",
  "toast.readFileError": "Failed to read file: {err}",
  "toast.openFileError": "Failed to open file: {err}",
  "toast.emptyFolder": "No .tap / .nc / .gcode / .cnc files found in folder",
  "toast.loadedFolder": "Loaded folder ({count} toolpath files)",
  "toast.scanFolderError": "Failed to scan folder: {err}",
  "toast.noValidFiles": "No .tap / .nc / .gcode / .cnc files found in selection",
  "toast.importedFiles": "Imported {count} toolpath files",
  "toast.downloadedPng": "Downloaded {name}",
  "toast.exportedPng": "Exported HD render: {path}",
  "toast.exportError": "Export failed: {err}",
  "toast.generatingStl": "Generating watertight binary STL mesh...",
  "toast.downloadedStl": "Downloaded {name} ({count} triangles)",
  "toast.exportedStl": "Exported watertight STL ({count} triangles): {path}",
  "toast.stlError": "STL export failed: {err}",
  "toast.desktopThumbOnly": "Available in desktop app or via: shibanc-cli register-thumbnails",
  "toast.desktopAssocOnly": "Available in desktop app or via: shibanc-cli register-associations",
  "toast.speedChanged": "Playback Speed: {label} ({desc})",
  "toast.langExported": "Exported language pack: {name}",
  "toast.langImported": "Imported language: {name} ({count} keys)",
  "toast.langImportError": "Invalid language JSON: {err}",
  "toast.langRemoved": "Removed custom language: {name}",
} as const;

export type TranslationKey = keyof typeof EN_TRANSLATIONS;
export type TranslationDict = Record<TranslationKey, string>;

export const ZH_CN_TRANSLATIONS: TranslationDict = {
  // Window & App
  "app.windowTitle": "ShibaNC — 高清三轴 G 代码刀路与实体切削仿真",
  "app.ready": "就绪",
  "app.dropMask": "松开鼠标加载 .tap / .nc 文件",
  "app.webgpuHint": "WebGPU 提示: {error}",

  // Topbar — Center Mode & Inspection
  "topbar.mode.solid": "实体",
  "topbar.mode.solidTip": "仅显示加工后的三维实体效果",
  "topbar.mode.toolpath": "仅刀路",
  "topbar.mode.toolpathTip": "只显示三维刀路轨迹图与材料外框",
  "topbar.mode.both": "实体+刀路",
  "topbar.mode.bothTip": "同时显示加工后实体与刀路轨迹",
  "topbar.section": "剖切",
  "topbar.sectionTip": "开启三维动态剖切面，透视检查盲孔深度、内腔壁厚与底厚",
  "topbar.measure": "测量",
  "topbar.measureTip": "在三维模型表面实时测深或点击任意两点测量距离与高差 (快捷键 M)",
  "topbar.quadView": "四视图",
  "topbar.quadViewTip": "切换 Blender 四视图 / 单视图 (快捷键 Q 或 Ctrl+Alt+Q)",

  // Topbar — Right Menus (View, G-Code, Export, Language, Theme)
  "topbar.view": "视图",
  "topbar.viewTip": "多视图分屏布局与场景辅助开关",
  "topbar.view.layoutTitle": "多视图窗口布局 (Q)",
  "topbar.view.single": "单视图",
  "topbar.view.dual": "双视图",
  "topbar.view.quad": "四视图",
  "topbar.view.showCutter": "显示三维刀具",
  "topbar.view.showFloor": "显示基准网格与坐标轴",
  "topbar.view.showRapids": "显示 G0 快速空移线",
  "topbar.view.showRapidsDesc": "在刀路模式下显示红色抬刀轨迹",
  "topbar.view.fileAssoc": ".nc / .tap 默认打开",
  "topbar.view.fileAssocDesc": "双击系统刀路文件直接打开",
  "topbar.view.osThumb": "资源管理器 3D 缩略图",
  "topbar.view.osThumbDesc": "文件夹大图标显示立体加工预览",

  "topbar.gcode": "G代码",
  "topbar.gcodeTip": "展开/收起右侧 G 代码面板",

  "topbar.export": "导出",
  "topbar.exportTip": "导出高清 PNG 渲染图或闭合三维 STL 实体模型",
  "topbar.export.title": "选择导出格式",
  "topbar.export.pngTitle": "导出高清预览图 (.png)",
  "topbar.export.pngDesc": "1920×1440 · 4x MSAA 工作室级离屏渲染图",
  "topbar.export.stlTitle": "导出三维网格模型 (.stl)",
  "topbar.export.stlDesc": "闭合二进制 STL 实体网格 · 可用于 CAD / 3D 打印",

  "topbar.langTip": "切换界面语言或导入/导出自定义翻译包 (.json)",
  "topbar.lang.menuTitle": "界面语言 / Language",
  "topbar.lang.customSection": "自定义导入语言",
  "topbar.lang.import": "导入语言包 (.json)",
  "topbar.lang.importDesc": "加载用户翻译的 JSON 语言文件",
  "topbar.lang.export": "导出语言模板 (.json)",
  "topbar.lang.exportDesc": "导出当前语言键值供自行翻译修改",
  "topbar.lang.removeTip": "移除此自定义语言包",

  "topbar.theme.toLight": "切换至亮色主题",
  "topbar.theme.toDark": "切换至暗色主题",

  // Version & Auto-Update
  "update.versionTip": "当前版本 v{ver} · 点击检查更新",
  "update.newBadge": "新版本",
  "update.popoverTitle": "版本信息与自动更新",
  "update.currentVer": "当前版本",
  "update.status.idle": "当前已是最新状态 (v{ver})",
  "update.status.checking": "正在检查新版本...",
  "update.status.available": "发现新版本 v{ver}",
  "update.status.downloading": "正在下载更新包 ({pct}%)...",
  "update.status.installing": "正在安装更新并重启应用...",
  "update.status.upToDate": "当前已是最新版本 (v{ver})",
  "update.status.needRepo": "请填写 GitHub 仓库 (owner/repo) 以检查更新",
  "update.status.error": "检查更新失败: {err}",
  "update.checkBtn": "检查更新",
  "update.installRestartBtn": "立即更新并重启 (v{ver})",
  "update.downloadInstallerBtn": "下载新版本安装包 (v{ver})",
  "update.viewReleaseBtn": "查看发行说明",
  "update.autoCheck": "启动时自动检查更新",
  "update.repoLabel": "更新源仓库",
  "update.repoPlaceholder": "owner/ShibaNC",
  "toast.updateAvailable": "发现新版本 v{ver} 可供更新！",
  "toast.upToDate": "当前 v{ver} 已是最新版本",

  // Left Sidebar Tabs & Parameters
  "sidebar.tab.params": "加工参数",
  "sidebar.tab.files": "刀路文件",
  "sidebar.resizeLeftTip": "拖拽调整左栏宽度",
  "sidebar.resizeRightTip": "拖拽调整右栏宽度",

  "params.material": "材质",
  "params.quality": "精度",
  "params.quality.fast": "流畅",
  "params.quality.hd": "高清",
  "params.quality.ultra": "超清",
  "params.resetStockTip": "重置为自动推断材料尺寸",
  "params.dimX": "长 X",
  "params.dimY": "宽 Y",
  "params.dimZ": "厚 Z",
  "params.origin": "原点",
  "params.origin.center": "居中",
  "params.origin.centerTip": "材料围绕刀路中心对称排布",
  "params.origin.corner": "左下角",
  "params.origin.cornerTip": "材料左下角对齐 G 代码 (0, 0) 原点",
  "params.datum": "对刀",
  "params.datum.top": "顶面",
  "params.datum.topTip": "刀具移动至材料顶面对刀基准面",
  "params.datum.bottom": "底面",
  "params.datum.bottomTip": "刀具移动至材料底面对刀基准面",
  "params.cutter": "刀具",
  "params.resetToolTip": "重置为自动推断刀具参数",
  "params.diameter": "直径 D",
  "params.cornerRadius": "圆角 R",
  "params.taperAngle": "锥角 α",

  // Sidebar Status Bar
  "status.lines": "{count} 行",
  "status.tooltip": "{file} · 毛坯 {x}×{y}×{z}mm · 解析 {ms}ms",

  // Materials
  "material.dropdownLabel": "选择工件显示材质",
  "material.4.name": "松木 (天然原木)",
  "material.4.desc": "浅色原木纹理 · 木工开料 / 牌匾浮雕",
  "material.1.name": "缅甸花梨木",
  "material.1.desc": "深色红木年轮 · 精细木雕 / 摆件精雕",
  "material.0.name": "6061 航空铝",
  "material.0.desc": "拉丝银灰高光 · 机械壳体 / 模具铣削",
  "material.2.name": "H62 精密黄铜",
  "material.2.desc": "暖金金属反射 · 精密铜件 / 印章铭牌",
  "material.3.name": "翡翠玉石",
  "material.3.desc": "温润通透玉质 · 玉器牌子 / 浅浮雕",
  "material.5.name": "切深等高云图",
  "material.5.desc": "伪彩色深度色阶 · 1mm 等高线检测",

  // Cutters
  "tool.dropdownLabel": "选择三轴切削刀具",
  "tool.diagramTip": "当前刀具截面比例示意",
  "tool.flat_end_mill.name": "平底立铣刀",
  "tool.flat_end_mill.desc": "平底直壁 · 开粗 / 型腔 / 轮廓",
  "tool.ball_nose.name": "球头铣刀",
  "tool.ball_nose.desc": "半球刀尖 · 3D 曲面精加工",
  "tool.tapered_ball_nose.name": "锥度球头刀 (浮雕)",
  "tool.tapered_ball_nose.desc": "锥度细球尖 · 木工/玉石浮雕主力",
  "tool.bull_nose.name": "圆鼻铣刀",
  "tool.bull_nose.desc": "底角圆鼻 · 模具开粗 / 圆角底面",
  "tool.v_bit.name": "V型雕刻刀",
  "tool.v_bit.desc": "锥形尖刀 · 字体线雕 / 棱边倒角",

  // Stock Diagram
  "stock.diagramTip": "材料长宽厚三维比例与对刀原点示意（虚线框为刀路加工范围）",
  "stock.outOfBounds": "提示: 当前刀路超出所设材料长宽边界",

  // File Explorer Pane
  "files.openFile": "打开文件",
  "files.openFileTip": "选择一个或多个 .nc / .tap / .gcode / .cnc 文件",
  "files.openFolder": "文件夹",
  "files.openFolderTip": "导入整个刀路文件夹",
  "files.viewSwitchAria": "视图切换",
  "files.cardViewTip": "卡片预览图视图",
  "files.listViewTip": "紧凑列表视图",
  "files.searchPlaceholder": "搜索刀路文件...",
  "files.clear": "清空",
  "files.clearTip": "清空导入列表",
  "files.renderingThumb": "生成 3D 预览...",
  "files.renderingShort": "3D 预览...",
  "files.builtinGroup": "内置示例",
  "files.sample.reliefSub": "莲花圆牌浮雕 · 28,954 行",
  "files.sample.mechSub": "轴承座铣削 · 203 行",
  "files.dropHint": "支持直接拖入 .nc / .tap 文件或文件夹",

  // Viewport HUD, Cross-Section, Heatmap & Playback Dock
  "hud.roiBadge": "显微重采样 {um} μm",
  "section.x": "X 剖切",
  "section.y": "Y 剖切",
  "section.sliderTip": "拖动剖切平面位置",
  "section.closeTip": "关闭三维剖切",
  "heatmap.title": "切深云图色阶",
  "heatmap.sub": "1mm 等高线",

  "dock.stepBackTip": "后退一段 (← 单步 / 长按连续快退 / Shift+← 快退10% / J 快退5%)",
  "dock.playTip": "播放仿真 (Space / K · 播放时按 ←/→ 快退/快进5%)",
  "dock.pauseTip": "暂停仿真 (Space / K)",
  "dock.stepFwdTip": "前进一段 (→ 单步 / 长按连续快进 / Shift+→ 快进10% / L 快进5%)",
  "dock.linePrefix": "行",
  "dock.lineBtnTip": "当前执行 G 代码行号（点击展开/定位代码面板）",

  // Speed Select
  "speed.triggerTip": "切换回放倍速 (数字键 1-6 或 ↑ / ↓)",
  "speed.menuTitle": "回放倍速 · 按数字键 1-6",
  "speed.1": "精细慢放",
  "speed.2": "平稳观察",
  "speed.5": "常速预览",
  "speed.10": "标准快进",
  "speed.30": "快速推进",
  "speed.100": "极速快进",

  // ViewCube
  "viewcube.homeTip": "复位默认透视视角 (快捷键 F)",
  "viewcube.face.top": "上",
  "viewcube.face.bottom": "下",
  "viewcube.face.front": "前",
  "viewcube.face.back": "后",
  "viewcube.face.right": "右",
  "viewcube.face.left": "左",
  "viewcube.faceTip": "{face}视图（正交）",
  "viewcube.vertexTip": "{x}·{y}·{z} 顶点（正交等轴测）",
  "viewcube.ortho": "正交",
  "viewcube.persp": "透视",
  "viewcube.projTip": "点击切换正交投影 / 透视投影",

  // Multi-View Overlay
  "mv.customOrtho": "三维 · 正交",
  "mv.customPersp": "三维 · 透视",
  "mv.preset.top_xy": "顶视图 · XY",
  "mv.preset.front_xz": "前视图 · XZ",
  "mv.preset.right_yz": "右视图 · YZ",
  "mv.preset.left_yz": "左视图 · YZ",
  "mv.preset.back_xz": "后视图 · XZ",
  "mv.preset.bottom_xy": "底视图 · XY",
  "mv.preset.iso_ortho": "正交等轴测",
  "mv.preset.persp_3d": "三维透视",
  "mv.splitVTip": "拖拽调整左右视口比例（双击恢复均分）",
  "mv.splitHTip": "拖拽调整上下视口比例（双击恢复均分）",
  "mv.splitCrossTip": "拖拽十字交点同时调整四视图比例（双击恢复均分）",
  "mv.paneTriggerTip": "点击切换该窗口视角预设 · 双击最大化",
  "mv.maximizeTip": "最大化此视图窗口",
  "mv.menuTitle": "切换子窗口视图",
  "mv.resetFit": "居中复位当前子视图",

  // Measure Overlay
  "measure.hintIdle": "移动鼠标实时测深，点击模型任意两点测量三维距离与高差",
  "measure.hintPending": "点击模型上第二个点完成测量（按 Esc 取消，按住左键仍可旋转视角）",
  "measure.clear": "清除 ({count})",
  "measure.deleteTip": "删除此条测量",
  "measure.horiz": "水平 {val}",
  "measure.depth": "切深",

  // Right G-Code Panel
  "gcode.title": "G 代码",
  "gcode.lineBadge": "行 {cur} / {total}",
  "gcode.centerTip": "点击居中当前执行行",
  "gcode.locateTip": "定位到当前高亮行",
  "gcode.closeTip": "收起 G 代码面板",

  // Dialogs & Toasts
  "dialog.filterGcode": "CNC 刀路文件 (.tap, .nc, .gcode, .cnc)",
  "dialog.openFolderTitle": "选择包含 .tap / .nc 刀路的文件夹",
  "dialog.filterPng": "PNG 高清图像 (.png)",
  "dialog.filterStl": "STL 三维网格模型 (.stl)",
  "dialog.filterJson": "JSON 语言包 (.json)",
  "dialog.exportPreviewSuffix": "_3D预览.png",

  "toast.sampleError": "加载示例失败: {err}",
  "toast.loadedFile": "已加载 {name}",
  "toast.readFileError": "读取文件失败: {err}",
  "toast.openFileError": "打开文件失败: {err}",
  "toast.emptyFolder": "该文件夹下未找到 .tap / .nc / .gcode / .cnc 刀路文件",
  "toast.loadedFolder": "已加载文件夹，共发现 {count} 个刀路文件",
  "toast.scanFolderError": "扫描文件夹失败: {err}",
  "toast.noValidFiles": "所选文件中未找到 .tap / .nc / .gcode / .cnc 刀路文件",
  "toast.importedFiles": "已导入 {count} 个刀路文件",
  "toast.downloadedPng": "已下载 {name}",
  "toast.exportedPng": "已导出高清图: {path}",
  "toast.exportError": "导出失败: {err}",
  "toast.generatingStl": "正在生成闭合二进制 STL 三维网格...",
  "toast.downloadedStl": "已下载 {name}（{count} 个三角面）",
  "toast.exportedStl": "已导出闭合 STL 模型（{count} 个三角面）: {path}",
  "toast.stlError": "导出 STL 失败: {err}",
  "toast.desktopThumbOnly": "请在桌面端开启，或执行 shibanc-cli register-thumbnails",
  "toast.desktopAssocOnly": "请在桌面端开启，或执行 shibanc-cli register-associations",
  "toast.speedChanged": "回放倍速: {label} ({desc})",
  "toast.langExported": "已导出语言包: {name}",
  "toast.langImported": "已导入语言: {name}（共 {count} 条词条）",
  "toast.langImportError": "语言包格式无效: {err}",
  "toast.langRemoved": "已移除自定义语言: {name}",
};

export interface LocalePack {
  code: string;
  name: string;
  shortLabel: string;
  builtin: boolean;
  translations: Partial<Record<TranslationKey, string>>;
}

export const BUILTIN_LOCALES: LocalePack[] = [
  {
    code: "en",
    name: "English",
    shortLabel: "EN",
    builtin: true,
    translations: EN_TRANSLATIONS,
  },
  {
    code: "zh-CN",
    name: "简体中文",
    shortLabel: "中文",
    builtin: true,
    translations: ZH_CN_TRANSLATIONS,
  },
];

export interface ExportedLocaleFile {
  format: "shibanc-locale-v1";
  code: string;
  name: string;
  shortLabel: string;
  _instructions: string;
  translations: Record<TranslationKey, string>;
}

const ALL_KEYS = Object.keys(EN_TRANSLATIONS) as TranslationKey[];

export function buildExportedLocaleJson(pack: LocalePack): string {
  const merged = {} as Record<TranslationKey, string>;
  for (const key of ALL_KEYS) {
    merged[key] = pack.translations[key] ?? EN_TRANSLATIONS[key];
  }
  const payload: ExportedLocaleFile = {
    format: "shibanc-locale-v1",
    code: pack.code === "en" || pack.code === "zh-CN" ? `${pack.code}-custom` : pack.code,
    name:
      pack.code === "en"
        ? "Custom English"
        : pack.code === "zh-CN"
        ? "自定义中文"
        : pack.name,
    shortLabel: pack.shortLabel,
    _instructions:
      "Edit 'code', 'name', 'shortLabel', and translate values inside 'translations'. Keep {placeholders} intact, then import this JSON file in ShibaNC.",
    translations: merged,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function parseImportedLocaleJson(
  rawText: string,
  fallbackFileName = "custom.json"
): { pack: LocalePack; keyCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Root value must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const stem = fallbackFileName
    .replace(/\.[^.]+$/, "")
    .replace(/^shibanc[-_]?lang[-_]?/i, "")
    .trim();

  // Support either { code, name, translations: {...} } OR flat { "app.windowTitle": "..." }
  const dictSource =
    obj.translations &&
    typeof obj.translations === "object" &&
    !Array.isArray(obj.translations)
      ? (obj.translations as Record<string, unknown>)
      : obj;

  const validSet = new Set<string>(ALL_KEYS);
  const translations: Partial<Record<TranslationKey, string>> = {};
  let keyCount = 0;

  for (const [k, v] of Object.entries(dictSource)) {
    if (validSet.has(k) && typeof v === "string" && v.trim().length > 0) {
      translations[k as TranslationKey] = v;
      keyCount++;
    }
  }

  if (keyCount === 0) {
    throw new Error("No valid ShibaNC translation keys found");
  }

  let code =
    typeof obj.code === "string" && obj.code.trim().length > 0
      ? obj.code.trim()
      : stem || `custom-${Date.now()}`;
  // Prevent overwriting built-in 'en' or 'zh-CN' slots directly
  if (code === "en" || code === "zh-CN") {
    code = `${code}-custom`;
  }

  const name =
    typeof obj.name === "string" && obj.name.trim().length > 0
      ? obj.name.trim()
      : stem || code;

  const shortLabel =
    typeof obj.shortLabel === "string" && obj.shortLabel.trim().length > 0
      ? obj.shortLabel.trim().slice(0, 6)
      : code.slice(0, 4).toUpperCase();

  return {
    pack: {
      code,
      name,
      shortLabel,
      builtin: false,
      translations,
    },
    keyCount,
  };
}
