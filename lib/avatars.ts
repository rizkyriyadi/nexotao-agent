// Agent profile pictures (served from /public/agents-pp). The lead / first agent
// is ALWAYS hutao; the rest cycle through the others and duplicate if a team has
// more agents than pictures.
export const AGENT_PPS = [
  "/agents-pp/hutao-pp.jpeg", // index 0 — lead / first agent
  "/agents-pp/furina-pp.webp",
  "/agents-pp/aoteru-pp.webp",
  "/agents-pp/luffy-pp.jpg",
  "/agents-pp/reze-pp.jpg",
];

export const LEAD_PP = AGENT_PPS[0];

/** Profile picture for the agent at `index` (0 = hutao), duplicating past the end. */
export function agentPP(index: number): string {
  return AGENT_PPS[((index % AGENT_PPS.length) + AGENT_PPS.length) % AGENT_PPS.length];
}
