// The public status page: which parts are switched on and how fast they have been. No names, no
// positions, no chat ids and no keys, only yes or no and counts.
export function makeStatus({ engine, env = process.env, parts = {}, startedAt = Date.now(), now = Date.now }) {
  const on = (x) => (x ? 'on' : 'off');
  return () => ({
    ok: true,
    commit: String(env.RENDER_GIT_COMMIT || env.CALLOUT_COMMIT || 'unknown').slice(0, 7),
    uptimeSeconds: Math.floor((now() - startedAt) / 1000),
    parts: {
      telegram: on(parts.telegram?.()),
      telegramWebhook: on(env.TELEGRAM_WEBHOOK_SECRET && env.PUBLIC_URL),
      miniApp: on(env.TELEGRAM_BOT_TOKEN && env.PUBLIC_URL),
      discordNotices: on(env.DISCORD_WEBHOOK_URL),
      discordButtons: on(env.DISCORD_BOT_TOKEN && env.DISCORD_PUBLIC_KEY),
      ai: on(parts.ai),
      googleSheet: on(parts.sheet),
      stateCopy: on(parts.sheet && env.STATE_SHEET_ID),
      speechToText: on(env.ASSEMBLYAI_API_KEY),
      testRoutes: on(env.CALLOUT_DEV === '1'), // must be off on a public server
    },
    runsEnded: Object.values(engine.runs).filter((r) => r.status === 'ended').length,
    // From the last 50 of each since the server started.
    timings: engine.timingSummary(),
  });
}
