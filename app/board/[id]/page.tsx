import { AppShell } from "@/components/AppShell";
import { IssueDetail } from "@/components/board/IssueDetail";

export default async function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell active="board"><IssueDetail id={id} /></AppShell>;
}
