type IconName = "overview" | "receive" | "inventory" | "scan" | "load" | "import" | "manage" | "search" | "refresh";

export function OperationIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    receive: <><path d="M12 3v11m-4-4 4 4 4-4M4 14v7h16v-7" /></>,
    inventory: <><path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10M7 5l9 4" /></>,
    overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    scan: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 7v10m4-10v10m3-10v10m3-10v10" /></>,
    load: <><path d="M3 5h11v12H3zM14 9h4l3 4v4h-7M14 13h7" /><circle cx="7" cy="18" r="2" /><circle cx="18" cy="18" r="2" /></>,
    import: <><path d="M12 15V3m-4 4 4-4 4 4M4 14v6h16v-6" /></>,
    manage: <><path d="M9 4H5v17h14V4h-4" /><rect x="9" y="2" width="6" height="4" rx="1" /><path d="M8 11h8m-8 5h5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" /></>,
  };
  return <svg className="operation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
