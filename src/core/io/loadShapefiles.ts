/**
 * 여러 파일(.shp/.dbf/.prj/.cpg 묶음 또는 .zip)을 레이어별로 묶어 하나의 GeoJSON 으로 합친다.
 * 관로(선) 레이어와 절점·밸브(점) 레이어를 함께 넣으면 한 관망으로 가져온다.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { readShapefile } from './shapefile';
import { readZip } from './zip';

export interface InputFile {
  name: string;
  data: ArrayBuffer;
}

export interface ShapefileSet {
  collection: FeatureCollection;
  crs: string | null;
  layers: string[];
  warnings: string[];
}

function splitName(path: string): { base: string; ext: string } {
  const file = path.split(/[\\/]/).pop() ?? path;
  const dot = file.lastIndexOf('.');
  return dot < 0 ? { base: file, ext: '' } : { base: file.slice(0, dot), ext: file.slice(dot + 1).toLowerCase() };
}

const BOM = String.fromCharCode(0xfeff);
const text = (data: ArrayBuffer) => {
  const decoded = new TextDecoder('utf-8').decode(data);
  return decoded.startsWith(BOM) ? decoded.slice(1) : decoded;
};

export async function loadShapefiles(files: InputFile[]): Promise<ShapefileSet> {
  // .zip 은 풀어서 일반 파일 목록에 넣는다 (macOS 의 __MACOSX 메타 파일은 무시).
  const expanded: InputFile[] = [];
  for (const file of files) {
    if (splitName(file.name).ext === 'zip') {
      for (const entry of await readZip(file.data)) {
        if (entry.name.includes('__MACOSX/')) continue;
        expanded.push({ name: entry.name, data: entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) as ArrayBuffer });
      }
    } else {
      expanded.push(file);
    }
  }

  const groups = new Map<string, { name: string; shp?: ArrayBuffer; dbf?: ArrayBuffer; prj?: string; cpg?: string }>();
  for (const file of expanded) {
    const { base, ext } = splitName(file.name);
    const key = base.toLowerCase();
    const group = groups.get(key) ?? { name: base };
    if (ext === 'shp') group.shp = file.data;
    else if (ext === 'dbf') group.dbf = file.data;
    else if (ext === 'prj') group.prj = text(file.data);
    else if (ext === 'cpg') group.cpg = text(file.data);
    else continue;
    groups.set(key, group);
  }

  const warnings: string[] = [];
  const features: Feature[] = [];
  const layers: string[] = [];
  let crs: string | null = null;
  for (const group of groups.values()) {
    if (!group.shp) {
      warnings.push(`${group.name}: .shp 파일이 없어 건너뛰었습니다.`);
      continue;
    }
    const result = readShapefile({ shp: group.shp, dbf: group.dbf, prj: group.prj, cpg: group.cpg }, group.name);
    warnings.push(...result.warnings);
    if (result.crs) {
      if (crs && crs !== result.crs) warnings.push(`${group.name}: 다른 레이어와 좌표계가 다릅니다 (${result.crs}). 첫 레이어 좌표계(${crs})로 처리합니다.`);
      crs ??= result.crs;
    }
    features.push(...result.collection.features);
    layers.push(`${group.name} (${result.collection.features.length})`);
  }
  if (layers.length === 0) throw new Error('.shp 파일을 찾지 못했습니다. .shp 와 .dbf(.prj) 를 함께 선택하거나 .zip 으로 묶어 주세요.');
  return { collection: { type: 'FeatureCollection', features }, crs, layers, warnings };
}
