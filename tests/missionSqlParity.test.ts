import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STARLIGHT_GATE_TEMPLATE,
  STARLIGHT_GATE_TEMPLATE_KEY,
  getMissionPalette,
} from "../src/domain/mission";

const SQL = readFileSync(
  new URL(
    "../supabase/migrations/202608110004_starlight_gate_missions.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Local/SQL 루멘문 계약", () => {
  it("템플릿 키·5색 팔레트·층 높이가 같다", () => {
    expect(SQL).toContain(`'${STARLIGHT_GATE_TEMPLATE_KEY}'`);
    expect(SQL).toContain(
      `array[${getMissionPalette(0).join(", ")}]::smallint[]`,
    );
    expect(SQL).toMatch(/'루멘문',\s*24,\s*array\[[^\]]+\]::smallint\[\],\s*7/u);
  });

  it("24개 정규 슬롯의 좌표·종류·회전이 같다", () => {
    const rows = [...SQL.matchAll(
      /\('60000000-0000-4000-8000-000000000001',\s*(\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*'(cube|stair|light)',\s*([0-3])\)/gu,
    )].map((match) => ({
      slotIndex: Number(match[1]),
      position: {
        x: Number(match[2]),
        y: Number(match[3]),
        z: Number(match[4]),
      },
      kind: match[5],
      rotation: Number(match[6]),
    }));

    expect(rows).toEqual(STARLIGHT_GATE_TEMPLATE.slots);
  });
});

