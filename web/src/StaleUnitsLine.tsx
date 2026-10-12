/** Administration → Status's operator action for stale Debian units (docs/ux.md §6). */
export function StaleUnitsLine({ units }: { units?: string[] }) {
  if (!units?.length) return null;
  return <p>{units.length === 1
    ? `${units[0]} is older than this release. Run install.sh to update it.`
    : "Some units are older than this release. Run install.sh to update them."}</p>;
}
