import { CampaignEditor } from './campaign-editor';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignEditor campaignId={id} />;
}
