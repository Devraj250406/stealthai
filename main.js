const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');

let mainWindow = null;
let isVisible = true;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const winWidth = 420;
  const winHeight = Math.min(screenHeight - 80, 900);

  app.dock.hide();

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: screenWidth - winWidth - 16,
    y: 40,
    frame: false,
    transparent: true,
    vibrancy: 'hud',
    visualEffectState: 'active',
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    minWidth: 340,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // ─── STEALTH CONSTRAINTS ───────────────────────────────────────────
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setContentProtection(true);

  mainWindow.loadFile('renderer/index.html');

  // ─── GLOBAL SHORTCUT: Toggle Visibility ────────────────────────────
  globalShortcut.register('CommandOrControl+Option+S', () => {
    if (isVisible) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      mainWindow.setContentProtection(true);
    }
    isVisible = !isVisible;
  });

  // ─── GLOBAL SHORTCUT: Stealth Minimize (Icon Mode) ────
  let isStealthMinimized = false;
  let previousBounds = null;
  globalShortcut.register('CommandOrControl+Option+M', () => {
    if (!mainWindow) return;
    
    if (!isStealthMinimized) {
      // Enter Stealth Minimize
      isStealthMinimized = true;
      previousBounds = mainWindow.getBounds();
      
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;

      // Physically shrink window to a 40x40 icon in bottom right
      mainWindow.setBounds({ x: width - 60, y: height - 60, width: 40, height: 40 });
      mainWindow.setOpacity(0.5); // Make it slightly visible as an icon
      
      // Remove from click processing so it doesn't block underlying apps
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      
      // Tell renderer to drop to icon mode UI
      mainWindow.webContents.send('app:stealthMinimizeState', true);
    } else {
      // Exit Stealth Minimize
      isStealthMinimized = false;
      
      // Restore bounds
      if (previousBounds) {
        mainWindow.setBounds(previousBounds);
      }
      
      mainWindow.setOpacity(isClickThrough ? 0.25 : 0.9);
      mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
      mainWindow.webContents.send('app:stealthMinimizeState', false);
    }
  });

  // ─── GLOBAL SHORTCUT: Toggle Click-Through (Stealth Mode) ───────────
  let isClickThrough = false;
  globalShortcut.register('CommandOrControl+Option+T', () => {
    isClickThrough = !isClickThrough;
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
      // Tell renderer to show visual indicator
      mainWindow.webContents.send('app:clickThroughState', isClickThrough);
    }
  });

  // ─── GLOBAL SHORTCUT: Silent Screenshot Capture (Shift+Space) ───────
  globalShortcut.register('Shift+Space', async () => {
    try {
      // Capture primary screen silently
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
      if (sources && sources.length > 0) {
        // Find primary screen or just take the first one
        const primarySource = sources[0]; 
        const base64Image = primarySource.thumbnail.toDataURL(); // data:image/png;base64,...
        
        if (mainWindow) {
          mainWindow.webContents.send('app:triggerAutoCapture', base64Image);
        }
      }
    } catch (e) {
      console.error('Silent capture failed:', e);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});



// ─── IPC: Window Opacity & Controls ──────────────────────────────────
ipcMain.handle('app:setOpacity', (_event, opacity) => {
  if (mainWindow) {
    mainWindow.setOpacity(Math.max(0.15, Math.min(1, opacity)));
  }
});

ipcMain.handle('app:close', () => {
  app.quit();
});

// ─── IPC: Desktop Capturer Sources (for system audio) ──────────────
ipcMain.handle('app:getSources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch {
    return [];
  }
});

// ─── IPC: Stealth Memory Screenshot (via Clipboard) ────────────────
const { clipboard } = require('electron');

ipcMain.handle('app:captureScreen', async () => {
  try {
    // Read the image directly from the system clipboard
    const image = clipboard.readImage();
    
    if (image.isEmpty()) {
      throw new Error('No image found in clipboard! Please take a screenshot first (Cmd+Ctrl+Shift+4).');
    }
    
    // Convert to Base64 JPEG to save payload size
    const imgBuffer = image.toJPEG(85);
    return imgBuffer.toString('base64');
  } catch (error) {
    console.error('Screenshot error:', error);
    throw error;
  }
});
