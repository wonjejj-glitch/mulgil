import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { crc32, networkDxf, networkShapefileZip } from './gisExport';
import { parseInp } from './inpParser';
import { loadShapefiles } from './loadShapefiles';
import { readZip } from './zip';

describe('GIS export', () => {
  const { model } = parseInp(sampleInp);

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a Shapefile zip that our own reader opens back with the same objects and coordinates', async () => {
    const zip = networkShapefileZip(model, null, 0, 'EPSG:5186');
    const entries = await readZip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer);
    expect(entries.map((e) => e.name).sort()).toEqual(
      ['links.cpg', 'links.dbf', 'links.prj', 'links.shp', 'links.shx', 'nodes.cpg', 'nodes.dbf', 'nodes.prj', 'nodes.shp', 'nodes.shx'].sort(),
    );
    const set = await loadShapefiles([{ name: 'net.zip', data: zip.buffer as ArrayBuffer }]);
    expect(set.crs).toBe('EPSG:5186');
    const points = set.collection.features.filter((f) => f.geometry?.type === 'Point');
    const lines = set.collection.features.filter((f) => f.geometry?.type === 'LineString');
    expect(points).toHaveLength(Object.keys(model.nodes).length);
    expect(lines).toHaveLength(Object.keys(model.links).length);
    const j1 = points.find((f) => f.properties?.ID === 'J1')!;
    expect(Number(j1.properties?.ELEV)).toBeCloseTo(model.nodes.J1.elevation, 3);
    // 좌표는 EPSG:5186 미터 (중부원점 범위)
    const [x, y] = (j1.geometry as { coordinates: number[] }).coordinates;
    expect(x).toBeGreaterThan(100000);
    expect(y).toBeGreaterThan(300000);
  });

  it('writes a DXF with layers, polylines and labels', () => {
    const dxf = networkDxf(model);
    expect(dxf.startsWith('0\r\nSECTION')).toBe(true);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    expect(dxf.match(/\r\nPOLYLINE\r\n/g)).toHaveLength(Object.keys(model.links).length);
    expect(dxf.match(/\r\nCIRCLE\r\n/g)).toHaveLength(Object.keys(model.nodes).length);
    expect(dxf).toContain('WN_PIPE');
  });
});
