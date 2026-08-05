export type CommandCategory = 'Action' | 'Navigate';

export type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  category: CommandCategory;
  keywords?: string[];
};

function searchableText(command: PaletteCommand): string {
  return [
    command.label,
    command.description,
    command.category,
    ...(command.keywords || []),
  ]
    .join(' ')
    .toLocaleLowerCase();
}
export function filterPaletteCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return commands;

  return commands.filter((command) => {
    const haystack = searchableText(command);
    return terms.every((term) => haystack.includes(term));
  });
}

export function moveActiveIndex(
  current: number,
  direction: 1 | -1,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  const safeCurrent = current < 0 || current >= itemCount ? 0 : current;
  return (safeCurrent + direction + itemCount) % itemCount;
}

export function moveTabIndex(
  current: number,
  key: string,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (key === 'ArrowRight') return moveActiveIndex(current, 1, itemCount);
  if (key === 'ArrowLeft') return moveActiveIndex(current, -1, itemCount);
  return current;
}
