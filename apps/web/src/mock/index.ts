import type { ApiClient } from '@/api/client';
import { MockApiClient } from './client';
import { devSwitches, type Scenario } from './devSwitches';
import type { AuditReport, MockMatchingEngine } from './engine';
import { buildScenario } from './seed';

export { devSwitches, DEV_SWITCH_DEFAULTS } from './devSwitches';
export type { DevSwitchState, Scenario } from './devSwitches';
export { SEEDED_RECIPIENTS, DEMO_GUEST, seededDepositResult } from './seed';
export type { SeededRecipient } from './seed';

const TICK_MS = 250;

let engine: MockMatchingEngine;
let currentScenario: Scenario = devSwitches.get().scenario;
let timer: ReturnType<typeof setInterval> | null = null;

const client = new MockApiClient({ engine: () => engine });
export const api: ApiClient = client;

function stopRunner(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** One interval for the page. While the tab is hidden it does nothing; the engine caps the catch-up on return. */
function startRunner(): void {
  stopRunner();
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    engine.tick(Date.now(), { publish: devSwitches.get().feedLag !== 'stuck' });
  }, TICK_MS);
}

function install(scenario: Scenario, demoGuest: boolean): void {
  stopRunner();
  currentScenario = scenario;
  const built = buildScenario(scenario, { demoGuest });
  engine = built.engine;
  client.engineReplaced();
  if (built.demoGuestId !== null) client.attachSession(built.demoGuestId, true);
  if (devSwitches.get().scenario !== scenario) devSwitches.set({ scenario });
  startRunner();
}

/** Rebuilds the market from the fixed seed. A signed-in demo guest is rebuilt with it; a plain guest is re-created fresh. */
export function resetMock(scenario: Scenario = currentScenario): void {
  install(scenario, client.hasDemoSession());
}

/** Rebuilds the current scenario with Guest 4817's seeded history and signs this tab in as that guest. */
export function enterAsSeededGuest(): void {
  install(currentScenario, true);
}

/** Conservation and reservation check over the live engine, for the dev page or the console. */
export function auditMock(): AuditReport {
  return engine.audit();
}

const unsubscribe = devSwitches.subscribe(() => {
  const { scenario } = devSwitches.get();
  if (scenario !== currentScenario) resetMock(scenario);
});

install(currentScenario, client.hasDemoSession());

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopRunner();
    unsubscribe();
  });
}
