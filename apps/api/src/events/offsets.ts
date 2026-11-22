import type { Admin } from '@platformatic/kafka';
import { EVENTS_PARTITIONS } from './topics.ts';

/**
 * Offsets, read through the admin API. Kafka's ListOffsets takes two magic
 * timestamps: -1 for the latest offset (the "high watermark", the offset the
 * next record will get) and -2 for the earliest still retained.
 */
const LATEST = -1n;

export async function highWatermarks(
  admin: Admin,
  topic: string,
  partitions = EVENTS_PARTITIONS,
): Promise<Map<number, bigint>> {
  const listed = await admin.listOffsets({
    topics: [
      {
        name: topic,
        partitions: Array.from({ length: partitions }, (_, i) => ({
          partitionIndex: i,
          timestamp: LATEST,
        })),
      },
    ],
  });
  const out = new Map<number, bigint>();
  for (const t of listed) for (const p of t.partitions) out.set(p.partitionIndex, p.offset);
  return out;
}

/** The group's committed offset per partition: the next offset it will read. -1 if none. */
export async function committedOffsets(
  admin: Admin,
  groupId: string,
  topic: string,
): Promise<Map<number, bigint>> {
  const groups = await admin.listConsumerGroupOffsets({ groups: [groupId] });
  const out = new Map<number, bigint>();
  for (const g of groups) {
    for (const t of g.topics) {
      if (t.name !== topic) continue;
      for (const p of t.partitions) out.set(p.partitionIndex, p.committedOffset);
    }
  }
  return out;
}

/** Messages the group has yet to commit past, summed over partitions. */
export function totalLag(high: Map<number, bigint>, committed: Map<number, bigint>): bigint {
  let lag = 0n;
  for (const [partition, hw] of high) {
    const c = committed.get(partition) ?? -1n;
    lag += c < 0n ? hw : hw > c ? hw - c : 0n;
  }
  return lag;
}
