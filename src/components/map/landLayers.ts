/** 지적도(브이월드 연속지적도) 필지 경계와 편입 필지 표시 — 관망 아래에 깐다. */
import type { Layer } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import type { CadastralParcel } from '../../app/vworldData';
import type { TakeoffResult } from '../../core/land/takeoff';
import type { LngLat } from '../../core/model/types';

interface Outline {
  path: LngLat[];
}
interface Filled {
  polygon: LngLat[][];
  isPublic: boolean;
}
interface Label {
  position: LngLat;
  text: string;
}

const center = (ring: LngLat[]): LngLat => {
  let x = 0, y = 0;
  for (const [a, b] of ring) {
    x += a;
    y += b;
  }
  return [x / ring.length, y / ring.length];
};

export function buildLandLayers(parcels: CadastralParcel[], result: TakeoffResult | null, zoom: number): Layer[] {
  if (parcels.length === 0) return [];
  const taken = new Map((result?.rows ?? []).map((r, i) => [r.pnu, { no: i + 1, isPublic: r.isPublic }]));
  const outlines: Outline[] = [];
  const filled: Filled[] = [];
  const labels: Label[] = [];
  for (const p of parcels) {
    for (const poly of p.polygons) for (const ring of poly) outlines.push({ path: ring });
    const t = taken.get(p.pnu);
    if (t) for (const poly of p.polygons) filled.push({ polygon: poly, isPublic: t.isPublic });
    const outer = p.polygons[0]?.[0];
    if (outer && (t ? zoom >= 16 : zoom >= 17.5)) labels.push({ position: center(outer), text: t ? `${p.jibun} (${t.no})` : p.jibun });
  }
  return [
    new SolidPolygonLayer<Filled>({
      id: 'land-taken',
      data: filled,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => (d.isPublic ? [120, 150, 190, 70] : [240, 150, 60, 110]),
    }),
    new PathLayer<Outline>({
      id: 'land-parcels',
      data: outlines,
      getPath: (d) => d.path,
      getColor: [250, 230, 140, 150],
      getWidth: 1,
      widthUnits: 'pixels',
    }),
    new TextLayer<Label>({
      id: 'land-labels',
      data: labels,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: 11,
      getColor: [255, 240, 190, 255],
      outlineWidth: 2,
      outlineColor: [15, 19, 24, 255],
      fontFamily: 'system-ui, "Segoe UI", sans-serif',
      fontSettings: { sdf: true },
      characterSet: 'auto',
    }),
  ];
}
