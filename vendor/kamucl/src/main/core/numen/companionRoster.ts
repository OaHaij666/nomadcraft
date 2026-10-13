import type { NumenCompanion } from '../../../shared/numen'
/** Upstream MCP can retain registered dormant companions; local body intent separates them from active controls. */
export function activeLocalCompanions(roster: NumenCompanion[], dormant: Array<{id: string}>): NumenCompanion[] {
  const sleeping = new Set(dormant.map(bot => bot.id))
  return roster.filter(bot => !sleeping.has(bot.id))
}
