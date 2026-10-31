import {
  movedQuickAddType,
  objectTypeIcon,
  quickAddChoice,
  quickAddStart,
  withoutQuickAddType,
  withQuickAddType,
  QUICK_ADD_LIMIT,
  type ObjectType,
} from '@dfai/domain';
import { QuickAddSettings, sidebarGlyph, type QuickAddRow } from '@dfai/ui';
import type { QuickAddSetting } from './use-quick-add-setting.ts';

/** Settings → Quick add, wired to the vault's settings note. */
export function QuickAddSettingsCard({
  setting,
  types,
}: {
  setting: QuickAddSetting;
  types: readonly ObjectType[];
}) {
  const list = quickAddStart({ configured: setting.configured, types });
  const { missing } = quickAddChoice({ configured: setting.configured, types });
  const rows: QuickAddRow[] = list.map((name) => {
    const type = types.find((candidate) => candidate.name === name);
    return {
      name,
      label: type?.label ?? name,
      icon: sidebarGlyph(objectTypeIcon(type ?? { name })),
      missing: missing.includes(name),
    };
  });
  const available = types
    .filter((type) => !list.includes(type.name))
    .map((type) => ({ name: type.name, label: type.label }));

  return (
    <QuickAddSettings
      rows={rows}
      available={available}
      limit={QUICK_ADD_LIMIT}
      problem={setting.problem}
      onAdd={(name) => setting.save(withQuickAddType(list, name))}
      onRemove={(name) => setting.save(withoutQuickAddType(list, name))}
      onMove={({ id, to }) => setting.save(movedQuickAddType({ list, name: id, to }))}
    />
  );
}
