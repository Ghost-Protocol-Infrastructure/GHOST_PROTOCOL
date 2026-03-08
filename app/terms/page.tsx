import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import GhostLogo from "@/components/GhostLogo";

const loadTerms = async (): Promise<string> => {
  const termsPath = path.join(process.cwd(), "TERMS_OF_SERVICE.md");
  try {
    return await readFile(termsPath, "utf8");
  } catch {
    return "TERMS_OF_SERVICE.md was not found in the deployment artifact.";
  }
};

export default async function TermsPage() {
  const termsText = await loadTerms();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-400 font-mono selection:bg-red-900 selection:text-white">
      <header className="border-b border-neutral-900 bg-neutral-950/90 backdrop-blur-sm px-4 py-3">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between text-xs tracking-widest">
          <Link href="/" className="font-bold text-neutral-100 transition-colors hover:text-red-500">
            <span className="inline-flex items-center gap-2">
              <GhostLogo className="h-4 w-4" />
              GHOST_PROTOCOL
            </span>
          </Link>
          <nav className="inline-flex items-center gap-6">
            <Link href="/" className="text-neutral-500 transition-colors hover:text-red-500">
              /home
            </Link>
            <Link href="/rank" className="text-neutral-500 transition-colors hover:text-red-500">
              /rank
            </Link>
            <span className="text-neutral-200">/terms</span>
            <Link href="/privacy" className="text-neutral-500 transition-colors hover:text-red-500">
              /privacy
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-6 py-10">
        <div className="border border-neutral-900 bg-neutral-950/70 p-6 md:p-8">
          <h1 className="mb-6 text-lg font-bold uppercase tracking-[0.18em] text-neutral-100">
            Terms of Service
          </h1>
          <article className="whitespace-pre-wrap text-sm leading-7 text-neutral-400">{termsText}</article>
        </div>
      </main>
    </div>
  );
}
