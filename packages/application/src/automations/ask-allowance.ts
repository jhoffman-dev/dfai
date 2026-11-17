import {
  asksSpentInHour,
  automationIdKey,
  sharesAskAllowance,
  type AutomationRule,
  type LocalTime,
  type LogEntry,
  type NamedLog,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { readRuleLog } from './automation-log.ts';
import { loadAutomations } from './load-automations.ts';

interface AllowancePorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
}

/**
 * The other rules whose logs the vault's one hourly ask allowance is counted
 * over (#179), each by its name and whether it is on (#813): every rule but
 * `rule` whose step spends it, on or off, since one turned off this hour still
 * spent what it asked; none when `rule`'s step does not.
 */
export async function allowanceSharers(
  { fs, markdown }: AllowancePorts,
  rule: AutomationRule,
): Promise<NamedLog[]> {
  if (!sharesAskAllowance(rule.action)) return [];
  const notePaths = await listVaultNotes({ fs });
  const { automations } = await loadAutomations({ fs, markdown, notePaths });
  return automations
    .filter(
      (other) =>
        automationIdKey(other.rule.id) !== automationIdKey(rule.id) &&
        sharesAskAllowance(other.rule.action),
    )
    .map((other) => ({ name: other.rule.name, entries: other.log, enabled: other.rule.enabled }));
}

/**
 * The log entries the vault's one hourly ask allowance is counted over
 * (#179): `own` — the rule's log as this run read it — and those of
 * {@link allowanceSharers}.
 */
async function allowanceEntries(
  ports: AllowancePorts,
  rule: AutomationRule,
  own: readonly LogEntry[],
): Promise<readonly LogEntry[]> {
  const sharers = await allowanceSharers(ports, rule);
  return [...own, ...sharers.flatMap((other) => other.entries)];
}

/**
 * How many asks the vault's hourly allowance has had in the hour up to `now`,
 * when `rule` spends it; 0 when it does not, as its asks are bounded by its
 * per-run budget alone.
 */
export async function askedThisHour(
  ports: AllowancePorts,
  rule: AutomationRule,
  now: LocalTime,
): Promise<number> {
  if (!sharesAskAllowance(rule.action)) return 0;
  const own = await readRuleLog(ports.fs, rule);
  return asksSpentInHour(await allowanceEntries(ports, rule, own.entries), now);
}
