import { requireAccess } from "@/lib/auth-access";
import { headers } from "next/headers";
import { CartFlowApp } from "./cartflow-app";
import { LoginForm } from "./login-form";
import { testToolsEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:3000";
  const access = await requireAccess(new Request(`http://${host}/`, { headers: requestHeaders }));
  if (access instanceof Response) {
    const error = await access.json() as { code?: string };
    return <LoginForm unavailable={access.status !== 401} retryable={error.code === "auth_unavailable"} />;
  }
  return <CartFlowApp initialAccess={{ ...access, testToolsEnabled: testToolsEnabled(access) }} />;
}
