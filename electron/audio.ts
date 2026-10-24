import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { WebContents } from "electron";

// Som do computador SEM o Discord. O Windows (10 versão 2004 ou superior) permite capturar todo o áudio
// deixando de fora um aplicativo e os processos dele; é assim que o Discord evita captar o próprio áudio.
// Usa o módulo nativo "loopback-capture". Se ele não estiver instalado, o som do computador fica indisponível.

export type AudioPlan = { available: boolean; excluded: "Discord" | "TelaLink" };

type CaptureInstance = { start: (pid: number, includeTree: boolean, callback: (chunk: Buffer) => void) => unknown; stop: () => void };
type LoopbackLib = { LoopbackCapture: new () => CaptureInstance };

let lib: LoopbackLib | null | undefined; // undefined = ainda não tentou carregar
let active: CaptureInstance | null = null;

function loadLib(): LoopbackLib | null {
    if (lib !== undefined) return lib;
    lib = null;
    if (process.platform !== "win32") return lib;
    try {
        const require = createRequire(import.meta.url);
        const mod = require("loopback-capture");
        const candidate = mod?.LoopbackCapture ? mod : mod?.default;
        if (candidate?.LoopbackCapture) lib = candidate as LoopbackLib;
    } catch (error) {
        console.warn("[TelaLink] Som do computador indisponível:", error);
    }
    return lib;
}

function runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`],
            { windowsHide: true, timeout: 10000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
    });
}

type RawProcess = { ProcessId?: number; ParentProcessId?: number };

// Procura o processo principal do Discord (o que não é filho de outro processo do Discord).
async function findDiscordPid(): Promise<number | null> {
    if (process.platform !== "win32") return null;
    try {
        const out = (await runPowerShell("Get-CimInstance Win32_Process -Filter \"Name like 'Discord%.exe'\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress")).trim();
        if (!out) return null;
        const parsed = JSON.parse(out) as RawProcess | RawProcess[];
        const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((item): item is Required<RawProcess> => typeof item.ProcessId === "number" && typeof item.ParentProcessId === "number");
        const ids = new Set(list.map((item) => item.ProcessId));
        const roots = list.filter((item) => !ids.has(item.ParentProcessId));
        if (roots.length === 0) return null;
        const descendants = (pid: number): number => list.filter((item) => item.ParentProcessId === pid).reduce((total, item) => total + 1 + descendants(item.ProcessId), 0);
        return roots.sort((a, b) => descendants(b.ProcessId) - descendants(a.ProcessId))[0].ProcessId;
    } catch (error) {
        console.warn("[TelaLink] Não foi possível procurar o Discord:", error);
        return null;
    }
}

// O que ficará de fora do som: o Discord (se estiver aberto) ou o próprio TelaLink (evita ouvir de volta as transmissões que você assiste).
export async function plan(): Promise<AudioPlan> {
    if (!loadLib()) return { available: false, excluded: "TelaLink" };
    return { available: true, excluded: (await findDiscordPid()) === null ? "TelaLink" : "Discord" };
}

export function stopSystemAudio(): void {
    const current = active;
    active = null;
    try { current?.stop(); } catch { /* já encerrado */ }
}

// Envia ao app o áudio PCM (16 bits, estéreo, 48 kHz) de todo o computador, menos o aplicativo deixado de fora.
export async function startSystemAudio(target: WebContents): Promise<boolean> {
    const library = loadLib();
    if (!library) return false;
    const excludedPid = (await findDiscordPid()) ?? process.pid;
    stopSystemAudio();
    try {
        const capture = new library.LoopbackCapture();
        capture.start(excludedPid, false, (chunk: Buffer) => {
            if (target.isDestroyed()) return;
            const copy = new Uint8Array(chunk.length); // cópia exata (um Buffer do Node pode apontar para um bloco compartilhado maior)
            copy.set(chunk);
            target.send("telalink:audio-chunk", copy);
        });
        active = capture;
        return true;
    } catch (error) {
        console.warn("[TelaLink] Falha ao iniciar a captura de áudio:", error);
        return false;
    }
}
