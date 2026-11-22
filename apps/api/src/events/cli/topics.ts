import { env } from '../../env.ts';
import { createAdmin } from '../kafka.ts';
import { ensureTopics, topicNames } from '../topics.ts';

/**
 * `npm run kafka:topics` — create the event log's topics if they are missing.
 * Safe to run on every deploy. The broker has auto-creation turned off, so
 * nothing else creates them.
 */

const admin = createAdmin({ brokers: env.KAFKA_BROKERS, clientId: 'daftar-topics' });

try {
  const created = await ensureTopics(admin, topicNames(env.KAFKA_NAMESPACE));
  process.stdout.write(
    created.length === 0 ? 'all topics exist\n' : `created: ${created.join(', ')}\n`,
  );
} catch (err) {
  process.stderr.write(
    `topic bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
} finally {
  await admin.close();
}
