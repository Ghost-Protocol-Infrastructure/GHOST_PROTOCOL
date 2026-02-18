export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="app-shell font-mono bg-neutral-950 text-neutral-400 selection:bg-red-500/30 selection:text-red-200 [background-image:none]">
      {children}
    </div>
  );
}
