export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="app-shell font-mono bg-slate-950 text-slate-400 selection:bg-violet-500/30 selection:text-violet-200">
      {children}
    </div>
  );
}
