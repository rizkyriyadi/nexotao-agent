// A task is a conversation: the original request, then whatever the user sent
// afterwards. Both halves of that — which messages a run is answering, and
// whether anything is left over when it stops — are decided here, from one read
// of the thread, because deciding them separately is what lost messages.
//
// The old shape compared `comment.createdAt > runStartedAt`, where the start was
// a clock read taken several awaits after the run was claimed. A message that
// landed in that gap was too new to be in the prompt and too old to count as
// waiting, so it was answered by nobody and shown to no one. Identity has no
// gap: the same list that builds the prompt is the list the run is responsible
// for, and anything not on it is by definition still owed a reply.

export type FollowUpComment = { id: string; authorType: string; body: string; createdAt: number };
export type ConversationMessage = { role: "user" | "assistant"; content: string };

export type OpenConversation = {
  /** What to send the agent: the request, the prior answer, then the follow-ups. */
  messages: ConversationMessage[];
  /** Ids of the user messages this run is answering. */
  answered: Set<string>;
};

/** Build the conversation for a run and record exactly which user messages it
 *  covers. The previous run's summary sits between the request and the
 *  follow-ups so the agent continues the task instead of restarting it. */
export function openConversation(
  issue: { title: string; detail?: string | null; summary?: string | null },
  comments: readonly FollowUpComment[],
): OpenConversation {
  const followUps = comments
    .filter((comment) => comment.authorType === "user")
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  const messages: ConversationMessage[] = [{ role: "user", content: issue.detail || issue.title }];
  if (followUps.length) {
    if (issue.summary) messages.push({ role: "assistant", content: issue.summary });
    for (const comment of followUps) messages.push({ role: "user", content: comment.body });
  }
  return { messages, answered: new Set(followUps.map((comment) => comment.id)) };
}

/** Whether the thread holds a user message this run never saw. Called after the
 *  run stops, against a fresh read, so a message that arrived at any point —
 *  including before the prompt was built but after the queue handed the run
 *  over — reopens the task rather than waiting for a reply that is not coming. */
export function hasUnansweredFollowUp(comments: readonly FollowUpComment[], answered: ReadonlySet<string>) {
  return comments.some((comment) => comment.authorType === "user" && !answered.has(comment.id));
}
