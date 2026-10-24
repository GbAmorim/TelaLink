import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("telalink", {
    getSources: () => ipcRenderer.invoke("telalink:get-sources"),
    setTheme: (theme: "dark" | "light") => ipcRenderer.invoke("telalink:set-theme", theme),
    audio: {
        plan: () => ipcRenderer.invoke("telalink:audio-plan"),
        start: () => ipcRenderer.invoke("telalink:audio-start"),
        stop: () => ipcRenderer.invoke("telalink:audio-stop"),
        onChunk: (callback: (chunk: Uint8Array) => void) => {
            const handler = (_event: unknown, chunk: Uint8Array) => callback(chunk);
            ipcRenderer.on("telalink:audio-chunk", handler);
            return () => { ipcRenderer.removeListener("telalink:audio-chunk", handler); };
        },
    },
});
