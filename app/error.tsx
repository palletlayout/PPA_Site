"use client";

export default function AppError({ reset }: { reset: () => void }) {
  return <main className="system-state" role="alert">
    <p className="eyebrow">PPA · Service interrupted</p>
    <h1>We couldn’t open the work queue.</h1>
    <p>Retry the connection. If you were recording a scan, check its status before repeating the action.</p>
    <button className="button button-primary" onClick={reset}>Try again</button>
  </main>;
}
