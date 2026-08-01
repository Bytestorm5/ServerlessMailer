import { CampaignReport } from './campaign-report';

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignReport campaignId={id} />;
}
