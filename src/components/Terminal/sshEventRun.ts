/** Accept SSH events only after this terminal knows the active backend run. */
export function isCurrentSshEvent(
  event: { id: string; runId?: string },
  sessionId: string,
  runId: string,
  mounted: boolean,
): boolean {
  return mounted && event.id === sessionId && !!runId && event.runId === runId
}
