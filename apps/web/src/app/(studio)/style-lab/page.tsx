import { StyleLab, type StyleTab } from '@/components/style/StyleLab';

export default async function StyleLabPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const initial: StyleTab = tab === 'review' || tab === 'bible' ? tab : 'library';
  return <StyleLab initialTab={initial} />;
}
