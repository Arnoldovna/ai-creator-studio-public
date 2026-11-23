/** One backup with everything, including the private strategy notes (Etappe 10). */
export function ExportButtons() {
  return (
    <div className="mt-4 flex flex-wrap gap-2" data-testid="export-buttons">
      <a href="/api/export" className="inline-block rounded-lg border border-[#dde2d2] bg-[#f2f4ec] px-4 py-2.5 text-xs font-bold">
        ↓ Backup als JSON (inkl. privater Notizen, nicht öffentlich teilen)
      </a>
    </div>
  );
}
