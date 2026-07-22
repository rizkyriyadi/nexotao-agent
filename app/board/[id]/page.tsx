import { redirect } from "next/navigation";

// Issue detail is now the live run view inside the control panel. Any deep link
// to an issue (inbox, overview, notifications) opens that run.
export default async function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/board?goal=${id}`);
}
