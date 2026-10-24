import { app, BrowserWindow, ipcMain, desktopCapturer } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as audio from "./audio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
    ? path.join(process.env.APP_ROOT, "public")
    : RENDERER_DIST;

let win: BrowserWindow | null = null;

// Lista as telas e janelas que podem ser compartilhadas.
ipcMain.handle("telalink:get-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false, // os ícones não são usados; evita trabalho extra
    });

    return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        displayId: source.display_id,
    }));
});

// Troca as cores da barra de título (botões do Windows) junto com o tema do app.
ipcMain.handle("telalink:set-theme", (_event, theme: "dark" | "light") => {
    if (!win || win.isDestroyed()) return;
    const light = theme === "light";
    try {
        win.setBackgroundColor(light ? "#e3e5e8" : "#1e1f22");
        win.setTitleBarOverlay({
            color: light ? "#e3e5e8" : "#1e1f22",
            symbolColor: light ? "#4e5058" : "#b5bac1",
            height: 32,
        });
    } catch {
        // plataforma sem barra de título personalizada
    }
});

// Som do computador sem o Discord: o Windows permite capturar todo o áudio deixando um aplicativo de fora.
ipcMain.handle("telalink:audio-plan", () => audio.plan());
ipcMain.handle("telalink:audio-start", (event) => audio.startSystemAudio(event.sender));
ipcMain.handle("telalink:audio-stop", () => audio.stopSystemAudio());
app.on("before-quit", () => audio.stopSystemAudio());

function createWindow() {
    win = new BrowserWindow({
        title: "TelaLink",
        width: 1180,
        height: 760,
        minWidth: 800,
        minHeight: 560,
        backgroundColor: "#1e1f22",
        autoHideMenuBar: true,
        // Barra de título escura integrada ao app (os botões do Windows ficam no canto).
        titleBarStyle: "hidden",
        titleBarOverlay: {
            color: "#1e1f22",
            symbolColor: "#b5bac1",
            height: 32,
        },
        webPreferences: {
            preload: path.join(__dirname, "preload.mjs"),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false, // verificador ortográfico não é necessário e consome memória
        },
    });

    if (VITE_DEV_SERVER_URL) {
        win.loadURL(VITE_DEV_SERVER_URL);
    } else {
        win.loadFile(path.join(RENDERER_DIST, "index.html"));
    }
}

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
        win = null;
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.whenReady().then(createWindow);
