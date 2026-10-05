import type { Metadata } from "next";
import "./globals.css";
import "./operations.css";
import "./handheld.css";
import "./handheld-loading.css";
import "./receive-inventory.css";
import "./inventory-list.css";

const description = "Monitor onsite trains and offsite loads from picklist to part-level verification in one supervisor control room.";

export const metadata: Metadata = {
  title: "PPA — Supervisor Control Room",
  description,
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "PPA — Supervisor Control Room",
    description,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "PPA — Supervisor Control Room",
    description,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
