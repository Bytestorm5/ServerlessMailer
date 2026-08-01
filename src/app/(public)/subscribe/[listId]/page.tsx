import { ObjectId } from 'mongodb';
import { notFound } from 'next/navigation';
import { collections } from '@/lib/db';
import { SubscribeForm } from './subscribe-form';

/**
 * Hosted signup form.
 *
 * Provided so a list is usable on day one without embedding anything. The
 * honeypot field and the identical-response guarantee live in the API, not
 * here — this page is only one possible client of `/api/subscribe`.
 */
export default async function SubscribePage({ params }: { params: Promise<{ listId: string }> }) {
  const { listId } = await params;
  if (!ObjectId.isValid(listId)) notFound();

  const c = await collections();
  const list = await c.lists.findOne({ _id: new ObjectId(listId) });
  if (!list || !list.active) notFound();

  return (
    <SubscribeForm
      listId={listId}
      listName={list.name}
      turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
    />
  );
}
