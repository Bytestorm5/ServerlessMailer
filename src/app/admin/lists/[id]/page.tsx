import { ListEditor } from './list-editor';

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListEditor listId={id} />;
}
