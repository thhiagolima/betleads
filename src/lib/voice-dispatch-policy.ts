/**
 * Voice dispatch is fail-closed until the channel has a recorded operational
 * acceptance. The cron may remain scheduled so it can be observed safely,
 * but it must not create calls unless this explicit runtime switch is enabled.
 */
export function isVoiceDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_DISPATCH_ENABLED === "true";
}
