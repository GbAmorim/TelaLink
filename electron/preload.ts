import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("telalink", {
    getSources: () => ipcRenderer.invoke("telalink:get-sources"),
    setTheme: (theme: "dark" | "light") => ipcRenderer.invoke("telalink:set-theme", theme),
});
