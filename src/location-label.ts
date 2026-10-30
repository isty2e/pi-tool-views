export function locationLabel(line1: number | undefined, identifier: string | undefined): string {
  return line1 === undefined ? identifier ?? "" : identifier === undefined ? String(line1) : `${line1} ${identifier}`;
}
