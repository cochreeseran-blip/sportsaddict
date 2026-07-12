// The hour (UTC) the day's board goes live and, for the moneyline board,
// locks for good. Shared between the newsletter send trigger (server.js)
// and the pipeline's moneyline freeze (pipeline.js) since they're the
// same moment: by default 13 UTC = 9 AM ET. Override with the existing
// NEWSLETTER_HOUR_UTC env var so one setting controls both.
export const GO_LIVE_HOUR_UTC = Number(process.env.NEWSLETTER_HOUR_UTC || 13);
