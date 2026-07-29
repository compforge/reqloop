/**
 * Keeps condition bands dominant while making newer Resources rank higher
 * within the same band. Valid JavaScript timestamps fit below MAX_SAFE_INTEGER.
 */
export function boardPriority(
  conditionPriority: number,
  creationTimestamp: string,
): number {
  return conditionPriority +
    Date.parse(creationTimestamp) / Number.MAX_SAFE_INTEGER;
}
