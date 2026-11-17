/**
 * crew views row (), Host side. It registers one read-only session projection, `crewReports`, which
 * folds member hand-over reports out of a conversation's own log (see `./reports.js`). Nothing
 * is written into any session; DHS keeps the folded value in its own projection cache, the same
 * way as its built-in projections. Everything else lives in the client half.
 */
import { reportsProjection } from './reports.js'

export const inject = ['sessionProjections']

/** Register the projection; a failure is logged and leaves the rest of the plugin working. */
export async function apply(ctx) {
  try {
    await ctx.sessionProjections.register(reportsProjection)
  } catch (error) {
    ctx.logger?.warn?.(`[crew-center] crewReports projection not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
}
