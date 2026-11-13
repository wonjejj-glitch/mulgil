/**
 * 최소 ZIP 읽기: 중앙 디렉터리를 읽고 저장(0)·deflate(8) 항목을 풀어낸다.
 * 압축 해제는 브라우저/Node 내장 DecompressionStream('deflate-raw') 를 쓴다(외부 의존성 없음).
 * ZIP64·암호화·분할 압축은 지원하지 않는다.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  // 국내 압축 프로그램은 파일 이름을 CP949 로 저장하는 경우가 많다.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // End of central directory: 끝에서부터 서명을 찾는다 (주석 최대 65535 바이트).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 파일 형식이 아닙니다.');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) throw new Error('ZIP 중앙 디렉터리가 손상되었습니다.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength), (flags & 0x800) !== 0);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // 폴더
    if (flags & 0x1) throw new Error(`암호화된 ZIP 항목은 열 수 없습니다: ${name}`);
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`ZIP 항목 헤더가 손상되었습니다: ${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) entries.push({ name, data: raw.slice() });
    else if (method === 8) entries.push({ name, data: await inflateRaw(raw) });
    else throw new Error(`지원하지 않는 ZIP 압축 방식(${method})입니다: ${name}`);
  }
  return entries;
}
