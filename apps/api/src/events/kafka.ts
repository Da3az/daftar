import {
  Admin,
  Consumer,
  Producer,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';

/**
 * # Kafka clients
 *
 * One place that decides how every client is built, so the choices below are
 * made once.
 *
 * ## The producer is idempotent, and that is narrower than it sounds
 *
 * `idempotent: true` makes the broker drop a batch it has already written
 * **from the same producer session** — a retry after a lost ack is not
 * duplicated. The library also pins `maxInflights = 1` and `acks = all` when
 * it is set. It does not survive a restart: a new process is a new producer
 * id, and the relay republishing a row it had sent but not yet marked is a
 * duplicate the broker cannot see. Consumers dedupe on `eventId` for that.
 *
 * ## Retries are bounded
 *
 * The library defaults an idempotent producer to `Number.MAX_SAFE_INTEGER`
 * retries, which with the broker down means a `send()` that never settles —
 * the relay would sit on its claimed rows until the stale-claim reaper took
 * them. A bounded count makes the send fail, the rows go back to `pending`,
 * and the outage is visible as backlog in `outbox_lag` instead of as a hung
 * promise. (`retries: true` is also the setting behind platformatic/kafka#481,
 * unbounded memory growth.)
 */

export interface KafkaConfig {
  brokers: string[];
  /** Distinguishes this process's connections on the broker. */
  clientId: string;
}

export type StringProducer = Producer<string, string, string, string>;
export type StringConsumer = Consumer<string, string, string, string>;

export function createProducer(config: KafkaConfig): StringProducer {
  return new Producer({
    clientId: config.clientId,
    bootstrapBrokers: config.brokers,
    serializers: stringSerializers,
    idempotent: true,
    retries: 5,
    retryDelay: 500,
    timeout: 10_000,
    // Topics are created by `kafka:topics`; a typo'd topic name must fail,
    // not quietly create a new empty topic.
    autocreateTopics: false,
  });
}

export function createConsumer(config: KafkaConfig & { groupId: string }): StringConsumer {
  return new Consumer({
    clientId: config.clientId,
    groupId: config.groupId,
    bootstrapBrokers: config.brokers,
    deserializers: stringDeserializers,
    autocommit: false,
    autocreateTopics: false,
    retries: 5,
    retryDelay: 500,
    timeout: 10_000,
    sessionTimeout: 20_000,
    heartbeatInterval: 3_000,
    maxWaitTime: 500,
    // The library's default of 1024 buffered messages per stream is tuned for
    // throughput; each message here costs a database transaction anyway, so a
    // deep buffer only means more to redeliver after a crash.
    highWaterMark: 64,
  });
}

export function createAdmin(config: KafkaConfig): Admin {
  return new Admin({
    clientId: config.clientId,
    bootstrapBrokers: config.brokers,
    retries: 3,
    retryDelay: 500,
    timeout: 10_000,
  });
}
