export function formatTokenUsageReminder(usedTokens: number, totalTokens: number): string {
  const remaining = Math.max(0, totalTokens - usedTokens);
  return `Token usage: ${usedTokens}/${totalTokens}; ${remaining} remaining`;
}

export function shouldEmitTokenUsageReminder(
  usedTokens: number,
  totalTokens: number,
  atFraction: number,
): boolean {
  return totalTokens > 0 && usedTokens >= totalTokens * atFraction;
}
