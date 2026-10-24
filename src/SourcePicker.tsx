import { Icon, PATHS } from "./icons";
import type { AudioMode, AudioPlan, CaptureSource, SourceKind } from "./types";

type SourceChooserProps = {
  sources: CaptureSource[];
  loading: boolean;
  kind: SourceKind;
  onKind: (kind: SourceKind) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

// Escolha da fonte: Tela inteira ou Janela. A lista rola quando é grande.
export function SourceChooser({ sources, loading, kind, onKind, selectedId, onSelect, onRefresh }: SourceChooserProps) {
  const screens = sources.filter((item) => item.id.startsWith("screen:"));
  const windows = sources.filter((item) => item.id.startsWith("window:"));
  const shown = kind === "screen" ? screens : windows;

  return (
    <>
      <div className="tabs">
        <button type="button" className={`tab ${kind === "screen" ? "active" : ""}`} onClick={() => onKind("screen")}>Tela inteira ({screens.length})</button>
        <button type="button" className={`tab ${kind === "window" ? "active" : ""}`} onClick={() => onKind("window")}>Janela ({windows.length})</button>
        <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={loading}><Icon d={PATHS.refresh} />{loading ? "Atualizando…" : "Atualizar"}</button>
      </div>
      {loading && sources.length === 0 && <div className="empty-state">Buscando telas disponíveis…</div>}
      {!loading && shown.length === 0 && <div className="empty-state">Nada encontrado aqui. Clique em Atualizar para tentar novamente.</div>}
      {shown.length > 0 && (
        <div className="source-grid">
          {shown.map((source) => (
            <button type="button" key={source.id} className={`source ${selectedId === source.id ? "selected" : ""}`} onClick={() => onSelect(source.id)}>
              <img src={source.thumbnail} alt={`Prévia de ${source.name}`} />
              {selectedId === source.id && <span className="source-check"><Icon d={PATHS.check} /></span>}
              <span className="source-name">{source.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

type AudioChooserProps = {
  mode: AudioMode;
  onMode: (mode: AudioMode) => void;
  plan: AudioPlan;
  watching: number;
};

// Som do computador (deixando o Discord de fora) ou sem som.
export function AudioChooser({ mode, onMode, plan, watching }: AudioChooserProps) {
  const effective: AudioMode = plan.available ? mode : "none";
  const options: Array<[AudioMode, string]> = [["computer", "Som do computador"], ["none", "Sem som"]];
  return (
    <div className="audio-chooser">
      <div className="field-label">Áudio da transmissão</div>
      <div className="segmented" role="radiogroup" aria-label="Áudio da transmissão">
        {options.map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={effective === key} className={effective === key ? "active" : ""} disabled={key === "computer" && !plan.available} onClick={() => onMode(key)}>{label}</button>
        ))}
      </div>
      {!plan.available && <div className="hint">O som do computador não está disponível aqui (precisa do Windows 10 versão 2004 ou superior).</div>}
      {plan.available && effective === "computer" && (
        <div className="hint">
          Fica de fora do som: {plan.excluded === "Discord" ? "o Discord" : "o próprio TelaLink"}.
          {plan.excluded === "Discord" && watching > 0 && " As transmissões que você assiste aqui entram no seu som: silencie-as para evitar eco."}
        </div>
      )}
    </div>
  );
}
