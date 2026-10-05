"use client";

import { useEffect, useRef, useState } from "react";

export type Confirmation = { message: string; requiredText?: string; title?: string; confirmLabel?: string; destructive?: boolean };
export function ConfirmationDialog({ confirmation, onDecision }: { confirmation: Confirmation; onDecision: (approved: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby="confirm-heading" onCancel={(event) => { event.preventDefault(); onDecision(false); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!confirmation.requiredText || typed === confirmation.requiredText) onDecision(true); }}>
      <p className="eyebrow">Review this action</p>
      <h2 id="confirm-heading">{confirmation.title || (confirmation.requiredText ? "Delete shared data" : "Confirm change")}</h2>
      <p>{confirmation.message}</p>
      {confirmation.requiredText && <label><span>Type {confirmation.requiredText} to confirm</span><input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
      <div className="confirmation-actions"><button type="button" className="button button-secondary" autoFocus onClick={() => onDecision(false)}>Cancel</button><button type="submit" className={`button ${confirmation.requiredText || confirmation.destructive ? "button-danger" : "button-primary"}`} disabled={Boolean(confirmation.requiredText && typed !== confirmation.requiredText)}>{confirmation.confirmLabel || (confirmation.requiredText ? "Delete all data" : "Confirm")}</button></div>
    </form>
  </dialog>;
}
