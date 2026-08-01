import { SubscriberDetail } from './subscriber-detail';

export default async function SubscriberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SubscriberDetail subscriberId={id} />;
}
