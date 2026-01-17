const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 700, // 宽度调整为更紧凑的矩形
    height: 900, // 高度调整为竖长矩形
    frame: false, // <--- 关键：设置为无边框模式
    backgroundColor: '#030712', // 背景色与 React 代码一致
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
    resizable: true, // 允许改变大小
  });
  
  // 修复：打包后麦克风无法使用的问题
  // 自动处理权限请求，允许 'media' (麦克风/摄像头)
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true); // 自动批准
    } else {
      callback(false);
    }
  });

  const isDev = process.env.NODE_ENV === 'development';
  console.log(`[Main] Running in ${isDev ? 'development' : 'production'} mode`);

  if (isDev) {
    const url = 'http://localhost:5173';
    win.loadURL(url).catch(err => console.error('[Main] Failed to load URL:', err));
  } else {
    // 生产环境加载构建好的 index.html
    const filePath = path.join(__dirname, '../dist/index.html');
    win.loadFile(filePath).catch(err => console.error('[Main] Failed to load file:', err));
  }
  
  win.on('ready-to-show', () => {
    win.show();
  });
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});