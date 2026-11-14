import { handleTick } from "../queue/tick.server";

// POST /internal/tick: lets an outside scheduler wake a sleeping machine and run what is due.
// See app/queue/tick.server.js. Hidden (404) unless CRON_SECRET is set.
export const action = ({ request }) => handleTick(request);
export const loader = ({ request }) => handleTick(request);
