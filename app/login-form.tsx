"use client";

import { useState, type FormEvent } from "react";
import "./login.css";

export function LoginForm({ unavailable = false, retryable = false }: { unavailable?: boolean; retryable?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to sign in.");
      window.location.assign("/");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to connect. Try again.");
      setBusy(false);
    }
  }
  return <main className="login-screen">
    <section className="login-card" aria-labelledby="sign-in-title">
      <div className="login-wordmark">PPA</div>
      <h1 className="login-title" id="sign-in-title">{retryable ? "Temporarily unavailable" : unavailable ? "Setup required" : "Sign in"}</h1>
      <p className="login-description">{retryable ? "We could not verify your session because the service is temporarily unavailable. Your access remains protected. Try again shortly." : unavailable ? "Access is locked until your administrator configures authentication for this deployment." : "Use your assigned PPA account."}</p>
      {retryable && <button className="login-submit" onClick={() => window.location.reload()}>Try again</button>}
      {!unavailable && <form className="login-form" onSubmit={signIn} aria-busy={busy}>
        <label className="login-field">Username<input className="login-input" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={120} disabled={busy} /></label>
        <label className="login-field">Password<input className="login-input" name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={busy} /></label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>}
      <p className="login-help">Access is assigned by role. Contact your administrator if you need an account or a password reset.</p>
    </section>
  </main>;
}
