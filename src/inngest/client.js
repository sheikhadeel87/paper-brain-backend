import { Inngest } from 'inngest';

const eventKey = String(process.env.INNGEST_EVENT_KEY || '').trim() || undefined;

export const inngest = new Inngest({
  id: 'paper-brain-backend',
  ...(eventKey ? { eventKey } : {}),
});
