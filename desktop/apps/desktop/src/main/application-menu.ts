import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";
import { applicationMenuRequestSchema, type AppLanguage } from "@pfsaa/contracts";
import { appMenuCopy } from "@pfsaa/i18n";

export function buildApplicationMenuTemplate(language: AppLanguage, isPackaged: boolean, onAbout: () => void, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const t = appMenuCopy[language];
  return [
    ...(platform !== "win32" ? [{
      id: "file",
      label: t.file,
      submenu: [
        { role: "close", label: t.close },
        { type: "separator" },
        { role: "quit", label: t.quit },
      ],
    }] satisfies MenuItemConstructorOptions[] : []),
    {
      id: "edit",
      label: t.edit,
      submenu: [
        { role: "undo", label: t.undo },
        { role: "redo", label: t.redo },
        { type: "separator" },
        { role: "cut", label: t.cut },
        { role: "copy", label: t.copy },
        { role: "paste", label: t.paste },
        { role: "selectAll", label: t.selectAll },
      ],
    },
    {
      id: "view",
      label: t.view,
      submenu: [
        // Reload and DevTools are development aids; keep them off the menu in
        // packaged builds where they only invite support requests.
        ...(!isPackaged ? ([
          { role: "reload", label: t.reload },
          { role: "forceReload", label: t.forceReload },
          { type: "separator" },
          { role: "toggleDevTools", label: t.toggleDevTools },
          { type: "separator" },
        ] satisfies MenuItemConstructorOptions[]) : []),
        { role: "resetZoom", label: t.resetZoom },
        { role: "zoomIn", label: t.zoomIn },
        { role: "zoomOut", label: t.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen", label: t.toggleFullscreen },
      ],
    },
    {
      id: "help",
      label: t.help,
      submenu: [
        {
          label: t.about,
          click: onAbout,
        },
      ],
    },
  ];
}

const openMenus = new WeakSet<BrowserWindow>();

export async function popupApplicationMenu(window: BrowserWindow, applicationMenu: Menu | null, input: unknown): Promise<void> {
  const request = applicationMenuRequestSchema.parse(input);
  const menu = request.menu === "all" ? applicationMenu : applicationMenu?.getMenuItemById(request.menu)?.submenu;
  if (!menu || window.isDestroyed()) throw new Error("Application menu is unavailable");
  if (openMenus.has(window)) throw new Error("An application menu is already open");
  const zoom = window.webContents.getZoomFactor();
  const [width, height] = window.getContentSize();
  const x = Math.max(0, Math.min(width - 1, Math.round(request.x * zoom)));
  const y = Math.max(0, Math.min(height - 1, Math.round(request.y * zoom)));
  openMenus.add(window);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { openMenus.delete(window); window.removeListener("closed", finish); resolve(); };
    window.once("closed", finish);
    try { menu.popup({ window, x, y, callback: finish }); }
    catch (error) { openMenus.delete(window); window.removeListener("closed", finish); reject(error); }
  });
}
