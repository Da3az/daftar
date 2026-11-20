import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getWebhookEvents, replayWebhookEvent, type WebhookEvent } from '@/lib/api';
import { formatTimestamp } from '@/lib/money';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  SkeletonRows,
  Table,
  Td,
  TdNum,
  Th,
  ThNum,
} from '@/components/ui/primitives';

export const Route = createFileRoute('/settlements')({ component: Settlements });

function Settlements(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  /** The most recent replay result, keyed by event id. */
  const [replayed, setReplayed] = useState<Record<string, string>>({});

  const page = useQuery({
    queryKey: ['webhook-events', cursor],
    queryFn: () => getWebhookEvents({ limit: 25, ...(cursor === null ? {} : { before: cursor }) }),
  });

  const replay = useMutation({
    mutationFn: (id: string) => replayWebhookEvent(id),
    onSuccess: (result, id) => {
      const body = result.body as { duplicate?: boolean; state?: string; error?: string };

      /*
       * The summary is phrased so that the *expected* outcome reads as a
       * success. A replay of a settled event comes back 200 `duplicate: true`
       * — the unique index decided it was a repeat — and labelling that
       * "duplicate" without context would read as a failure when it is the
       * guarantee being demonstrated.
       */
      setReplayed((current) => ({
        ...current,
        [id]:
          body.duplicate === true
            ? `${String(result.status)} · recognised as a duplicate — no second settlement`
            : body.error !== undefined
              ? `${String(result.status)} · ${body.error}`
              : `${String(result.status)} · ${body.state ?? 'processed'}`,
      }));

      void queryClient.invalidateQueries({ queryKey: ['webhook-events'] });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-ink-50 text-lg font-semibold">Settlements</h1>
        <p className="text-ink-400 text-xs">
          Every inbound delivery, including the ones that were rejected.
        </p>
      </div>

      {page.isError && <ErrorNote>Could not load webhook events.</ErrorNote>}

      <Card>
        <CardHeader
          title="Inbound webhook events"
          hint="Rejected deliveries are stored, not dropped: a stale replay and a forged signature are different events."
          actions={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={cursors.length === 1}
                onClick={() => setCursors((stack) => stack.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={page.data?.nextCursor === null || page.data === undefined}
                onClick={() =>
                  setCursors((stack) =>
                    page.data?.nextCursor === undefined || page.data.nextCursor === null
                      ? stack
                      : [...stack, page.data.nextCursor],
                  )
                }
              >
                Next
              </Button>
            </div>
          }
        />

        <Table>
          <thead>
            <tr>
              <Th>Provider</Th>
              <Th>Event id</Th>
              <Th>Type</Th>
              <Th>Signature</Th>
              <Th>Payload hash</Th>
              <Th>State</Th>
              <ThNum>Deliveries</ThNum>
              <Th>Received</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {page.isPending && <SkeletonRows columns={9} rows={8} />}

            {page.data?.events.length === 0 && (
              <tr>
                <Td colSpan={9}>
                  <Empty>
                    No events yet. Generate a signed one with{' '}
                    <span className="num">node scripts/sign-webhook.mjs</span>.
                  </Empty>
                </Td>
              </tr>
            )}

            {page.data?.events.map((event) => (
              <tr key={event.id} className="align-top">
                <Td className="text-xs">{event.provider}</Td>
                <Td className="num text-xs">{event.eventId}</Td>
                <Td className="text-ink-400 text-xs">{event.eventType}</Td>

                <Td className="text-xs">
                  <SignatureCell event={event} />
                </Td>

                <Td className="num text-ink-500 text-xs" title="Truncated to 16 hex characters">
                  {event.payloadHash}
                  {event.payloadConflictCount > 0 && (
                    <span className="text-debit mt-0.5 block">
                      {event.payloadConflictCount} conflicting payload
                      {event.payloadConflictCount === 1 ? '' : 's'}
                    </span>
                  )}
                </Td>

                <Td>
                  <Badge tone={stateTone(event.state)}>{event.state}</Badge>
                  {event.errorDetail !== null && (
                    <span className="text-ink-500 mt-0.5 block max-w-48 text-[11px]">
                      {event.errorDetail}
                    </span>
                  )}
                </Td>

                <TdNum className="text-xs">
                  {event.deliveryCount}
                  {event.duplicate && (
                    <Badge tone="warn" className="ml-1">
                      dup
                    </Badge>
                  )}
                </TdNum>

                <Td className="text-ink-400 whitespace-nowrap text-xs">
                  {formatTimestamp(event.receivedAt)}
                </Td>

                <Td>
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      size="sm"
                      disabled={replay.isPending && replay.variables === event.id}
                      onClick={() => replay.mutate(event.id)}
                      title="Re-sign the stored payload and send it through the real inbound handler"
                    >
                      <RotateCw className="size-3" aria-hidden />
                      Replay
                    </Button>

                    {replayed[event.id] !== undefined && (
                      <span className="text-ink-400 flex items-start gap-1 text-right text-[11px]">
                        <Check className="text-credit mt-0.5 size-3 shrink-0" aria-hidden />
                        {replayed[event.id]}
                      </span>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>

        <div className="border-ink-800 text-ink-500 space-y-1 border-t px-4 py-3 text-xs">
          <p>
            <strong className="text-ink-400">Replay sends the stored payload again</strong>,
            re-signed with a fresh timestamp, through the same handler a real provider hits — same
            signature check over raw bytes, same unique index. A replay of a settled event is{' '}
            <em>expected</em> to come back 200 with <span className="num">duplicate: true</span>.
            That is the idempotency guarantee, demonstrated rather than described.
          </p>
          <p>
            One honest limit: the original raw bytes are not retained, only the parsed payload and
            its hash. A replay re-serialises from <span className="num">jsonb</span>, so its hash
            matches only when the provider&apos;s formatting agreed with{' '}
            <span className="num">JSON.stringify</span>.
          </p>
        </div>
      </Card>
    </div>
  );
}

function SignatureCell({ event }: { event: WebhookEvent }): React.JSX.Element {
  /*
   * Signature validity and replay-window freshness are shown as two separate
   * facts, because they are. A correctly signed but stale payload is a replay;
   * a fresh payload with a bad signature is a forgery. Collapsing both into one
   * "valid" flag loses the distinction that decides which one happened.
   */
  if (!event.signatureValid) {
    return (
      <span className="text-debit flex items-center gap-1">
        <ShieldAlert className="size-3.5" aria-hidden />
        forged
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-credit flex items-center gap-1">
        <ShieldCheck className="size-3.5" aria-hidden />
        valid
      </span>
      {!event.withinWindow && (
        <span className="text-warn text-[11px]">outside replay window — stored, rejected</span>
      )}
    </span>
  );
}

function stateTone(state: string): 'credit' | 'debit' | 'warn' | 'neutral' {
  if (state === 'processed') return 'credit';
  if (state === 'failed') return 'debit';
  if (state === 'processing') return 'warn';
  return 'neutral';
}
