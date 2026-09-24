const CURRENT_PREFIX = "pfsaa.";
const LEGACY_PREFIX = "pideck.";

export function readPfsaaStorage(name: string): string | null {
  const currentKey = `${CURRENT_PREFIX}${name}`;
  const current = localStorage.getItem(currentKey);
  if (current !== null) return current;

  const legacy = localStorage.getItem(`${LEGACY_PREFIX}${name}`);
  if (legacy !== null) localStorage.setItem(currentKey, legacy);
  return legacy;
}

export function writePfsaaStorage(name: string, value: string): void {
  localStorage.setItem(`${CURRENT_PREFIX}${name}`, value);
}

export function removePfsaaStorage(name: string): void {
  localStorage.removeItem(`${CURRENT_PREFIX}${name}`);
}
