/** 관망 초안 미리보기: 수용가 점(연결됨/빠짐), 초안 관로, 수원·방류구. */
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Customer } from '../../core/io/customerCsv';
import type { DraftLink, DraftResult } from '../../core/model/networkDraft';
import type { LngLat } from '../../core/model/types';

export function buildDraftLayers(customers: Customer[] | null, result: DraftResult | null, source: LngLat | null, epoch: number): Layer[] {
  const layers: Layer[] = [];
  const unserved = new Set(result?.unserved.map((u) => u.id) ?? []);
  if (result) {
    layers.push(
      new PathLayer<DraftLink>({
        id: `draft-links-${epoch}`,
        data: result.links,
        getPath: (l) => l.path,
        getColor: [255, 196, 64, 230],
        getWidth: 3,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
    );
  }
  if (customers && customers.length > 0) {
    layers.push(
      new ScatterplotLayer<Customer>({
        id: `draft-customers-${epoch}`,
        data: customers,
        getPosition: (c) => c.position,
        getFillColor: (c) => (unserved.has(c.id) ? [240, 90, 90, 230] : [120, 200, 255, 220]),
        getRadius: 3.5,
        radiusUnits: 'pixels',
        stroked: true,
        getLineColor: [10, 14, 20, 200],
        lineWidthMinPixels: 1,
        updateTriggers: { getFillColor: [result] },
        pickable: false,
      }),
    );
  }
  if (source) {
    layers.push(
      new ScatterplotLayer<LngLat>({
        id: `draft-source-${epoch}`,
        data: [source],
        getPosition: (p) => p,
        getFillColor: [255, 196, 64, 255],
        getRadius: 8,
        radiusUnits: 'pixels',
        stroked: true,
        getLineColor: [10, 14, 20, 255],
        lineWidthMinPixels: 2,
        pickable: false,
      }),
    );
  }
  return layers;
}
