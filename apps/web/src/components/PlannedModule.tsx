import { PageHeader } from './ui';

export function PlannedModule({ eyebrow, title, accent, release, items }: { eyebrow: string; title: string; accent: string; release: string; items: string[] }) {
  return (
    <div className="appear">
      <PageHeader eyebrow={eyebrow} title={title} accent={accent} />
      <section className="panel border-dashed">
        <span className="inline-flex rounded-full border border-[#e8cf7a] bg-[#fff6db] px-2.5 py-1 text-[10px] font-semibold text-warn">GEPLANT · {release} · noch nicht funktionsfähig</span>
        <p className="hint mt-4">Dieses Modul ist bewusst noch nicht implementiert. Hier gibt es keine scheinbar funktionierenden Buttons. Geplanter Umfang:</p>
        <ul className="mt-2 list-disc pl-5 text-sm leading-7 text-[#343b2d]">{items.map((i) => <li key={i}>{i}</li>)}</ul>
      </section>
    </div>
  );
}
