import Link from "next/link";

export default function NotFound() {
  return <main className="system-state">
    <p className="eyebrow">PPA · Page not found</p>
    <h1>This page isn’t available.</h1>
    <p>Return to the operations dashboard to continue.</p>
    <Link className="button button-primary" href="/">Open PPA</Link>
  </main>;
}
