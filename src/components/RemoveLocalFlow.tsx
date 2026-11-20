import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import Dropdown from "./Dropdown";
import ConfirmDialog from "./ConfirmDialog";
import { removalSupport, removeLocalflow, type RemovalOutcome, type RemovalSupport, type RemoveChoice } from "../lib/ipc";

/** The three choices, their button labels and what each one does (shown everywhere it's chosen). */
export const REMOVE_CHOICES: Record<RemoveChoice, { label: string; button: string; explain: string; deletesData: boolean; removesApp: boolean }> = {
  app_and_data: {
    label: "Delete app and transcription data",
    button: "Delete app and data",
    explain: "LocalFlow will be moved to Trash, and your saved transcriptions and related history statistics will be permanently deleted. Settings, dictionary and downloaded models will remain.",
    deletesData: true,
    removesApp: true,
  },
  app_only: {
    label: "Delete app only",
    button: "Delete app",
    explain: "LocalFlow will be moved to Trash. Your saved transcriptions, settings and downloaded models will remain. Reinstalling LocalFlow will restore access to them.",
    deletesData: false,
    removesApp: true,
  },
  data_only: {
    label: "Delete transcription data only",
    button: "Delete transcription data",
    explain: "Your saved transcriptions and related history statistics will be permanently deleted. LocalFlow, settings, dictionary and downloaded models will remain.",
    deletesData: true,
    removesApp: false,
  },
};
const ORDER: RemoveChoice[] = ["app_and_data", "app_only", "data_only"];
export const CONFIRM_WORD = "DELETE";

type Result = { kind: "ok"; text: string } | { kind: "error"; text: string };

/** Settings → Remove LocalFlow. Picking an option deletes nothing; the dialog does. */
export default function RemoveLocalFlow() {
  const [choice, setChoice] = useState<RemoveChoice>("app_and_data");
  const [support, setSupport] = useState<RemovalSupport | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const c = REMOVE_CHOICES[choice];

  useEffect(() => {
    removalSupport().then(setSupport).catch(() => setSupport({ app_removable: false, reason: "Couldn't check whether the app can be removed." }));
  }, []);

  const appBlocked = c.removesApp && support !== null && !support.app_removable;
  const typedOk = !c.deletesData || typed === CONFIRM_WORD;

  const openDialog = () => { setTyped(""); setResult(null); setOpen(true); };

  const confirm = async () => {
    setBusy(true);
    let out: RemovalOutcome;
    try {
      out = await removeLocalflow(choice);
    } catch (e) {
      out = { data_deleted: false, app_removed: false, error: String(e) };
    }
    setBusy(false);
    setOpen(false);
    if (out.error) setResult({ kind: "error", text: out.error });
    else if (out.app_removed) setResult({ kind: "ok", text: out.data_deleted ? "Transcriptions deleted and LocalFlow moved to Trash. Quitting…" : "LocalFlow moved to Trash. Quitting…" });
    else if (out.data_deleted) setResult({ kind: "ok", text: "Your saved transcriptions were deleted." });
  };

  return (
    <section className="remove-localflow glass-panel" aria-labelledby="remove-localflow-title">
      <div className="remove-localflow-head">
        <h2 id="remove-localflow-title">Remove LocalFlow</h2>
        <p>Choose what to remove from this computer.</p>
      </div>
      <div className="remove-localflow-row">
        <Dropdown
          value={choice}
          onChange={(v) => { setChoice(v as RemoveChoice); setResult(null); }}
          options={ORDER.map((v) => ({ value: v, label: REMOVE_CHOICES[v].label }))}
          ariaLabel="What to remove"
          width={350}
        />
        <button type="button" className="button destructive" onClick={openDialog} disabled={appBlocked || busy}>
          <Trash2 size={15} aria-hidden="true" /> {c.button}
        </button>
      </div>
      <p className="remove-localflow-explain" aria-live="polite">{c.explain}</p>
      {appBlocked && support?.reason && <p className="remove-localflow-note">{support.reason}</p>}
      {result && (
        <p className={`remove-localflow-result is-${result.kind}`} role={result.kind === "error" ? "alert" : "status"}>
          {result.text}
        </p>
      )}

      <ConfirmDialog
        open={open}
        title={`${c.button}?`}
        confirmLabel={c.button}
        confirmDisabled={!typedOk}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      >
        <p>{c.explain}</p>
        {c.deletesData && (
          <>
            <p className="confirm-warning">Deleted transcriptions can't be recovered from LocalFlow. This can't be undone.</p>
            <label className="confirm-type">
              <span>Type <b>{CONFIRM_WORD}</b> to confirm</span>
              <input
                className="field"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-label={`Type ${CONFIRM_WORD} to confirm`}
              />
            </label>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
