/** Shared test fixtures. */
import { Nav } from "../src/nav";
import { bandsOf } from "../src/render/geometry";

/** Directors, Managers, two Associate floors, Interns. */
export function testNav(): Nav {
  const floors = [
    { key: "t0f0", tier: 0 as const },
    { key: "t1f0", tier: 1 as const },
    { key: "t2f0", tier: 2 as const },
    { key: "t2f1", tier: 2 as const },
    { key: "t3f0", tier: 3 as const },
  ];
  return new Nav(bandsOf({ floors: floors.map((f, i) => ({ ...f, index: i, desks: [] })) }));
}
