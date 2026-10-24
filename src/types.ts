export type CaptureSource = { id: string; name: string; thumbnail: string; displayId: string };
export type SourceKind = "window" | "screen";
export type AudioMode = "computer" | "none";
export type AudioPlan = { available: boolean; excluded: "Discord" | "TelaLink" };

export function sourceKindOf(sourceId: string): SourceKind {
  return sourceId.startsWith("window:") ? "window" : "screen";
}

declare global {
  interface Window {
    telalink: {
      getSources: () => Promise<CaptureSource[]>;
      setTheme?: (theme: "dark" | "light") => Promise<void>;
      // Som do computador sem o Discord (só no Windows, com o módulo loopback-capture instalado).
      audio?: {
        plan: () => Promise<AudioPlan>;
        start: () => Promise<boolean>;
        stop: () => Promise<void>;
        onChunk: (callback: (chunk: Uint8Array) => void) => () => void;
      };
    };
  }
  interface ImportMetaEnv { readonly VITE_SIGNALING_URL?: string }
  interface ImportMeta { readonly env: ImportMetaEnv }
}
