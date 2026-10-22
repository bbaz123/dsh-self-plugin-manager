/**
 * Plugin entry: mount the Host service that answers the Gateway namespace
 * `selfPlugins`.
 *
 * `inject: ['pluginManager']` is what keeps this plugin honest: the plugin
 * manager row is itself disabled outside a profile, so outside a profile this
 * row stays inactive instead of publishing a service that could only report
 * "unknown".
 *
 * @module dsh-self-plugin-manager
 */

import z from '@deepseek-ai/schemastery'
import { SelfPluginsService } from './service.js'

/** Loader diagnostics name. */
export const name = 'self-plugin-manager'

/** Required Host services. */
export const inject = ['pluginManager']

/**
 * Row config schema. An invalid value fails loudly at load time rather than
 * silently falling back.
 */
export const Config = z.object({
  /**
   * Master switch for the write path. `false` keeps every read capability and
   * refuses `update` / `rollback` with the code `writes-disabled`.
   */
  writesEnabled: z.boolean().default(true),
  /**
   * Directory holding the DPIP `plugin-state.json`. Empty means
   * `$DSH_HOME/operation-security`, which is where the shipped security layer
   * keeps it.
   */
  gateStateDir: z.string().default(''),
  /**
   * Directory holding this plugin's own `rollback.json`. Empty means
   * `$DSH_HOME/self-plugin-manager`.
   */
  storageDir: z.string().default(''),
  /**
   * Start a verification session after a change that actually took effect.
   *
   * Default `false`: creating a session and prompting an Agent is an action
   * taken on the operator's behalf, so it stays off until switched on here in
   * the patch layer. A change reporting `restart-required` never triggers it —
   * the new JavaScript generation is not loaded yet, so a fresh session would
   * be verifying the old code.
   */
  autoVerify: z.boolean().default(false),
  /**
   * Route for the verification session. Both must be set for the pair to be
   * used; either one empty falls back to the deployment default.
   *
   * There is deliberately no "cheapest model" setting: the Harness exposes no
   * token pricing, so a cost ranking cannot be computed. If you want a specific
   * cheap route, name it here.
   */
  verifyModelProvider: z.string().default(''),
  verifyModel: z.string().default(''),
})

/**
 * Mount the service on one Host context.
 * @param ctx - owning context.
 * @param config - validated row config.
 */
export function apply(ctx, config = {}) {
  new SelfPluginsService(ctx, config)
}
