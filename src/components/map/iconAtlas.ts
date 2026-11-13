/**
 * 지도 심벌(유향 화살표, 수원지, 배수지, 펌프, 밸브, 하수 방류구) 아이콘 아틀라스를 캔버스로 그려 만든다.
 */
const SIZE = 64;
const NAMES = ['arrow', 'reservoir', 'tank', 'pump', 'valve', 'outfall'] as const;
export type IconName = (typeof NAMES)[number];

export const ICON_MAPPING: Record<IconName, { x: number; y: number; width: number; height: number; mask: boolean }> = {
  arrow: { x: 0, y: 0, width: SIZE, height: SIZE, mask: true },
  reservoir: { x: SIZE, y: 0, width: SIZE, height: SIZE, mask: false },
  tank: { x: SIZE * 2, y: 0, width: SIZE, height: SIZE, mask: false },
  pump: { x: SIZE * 3, y: 0, width: SIZE, height: SIZE, mask: false },
  valve: { x: SIZE * 4, y: 0, width: SIZE, height: SIZE, mask: false },
  outfall: { x: SIZE * 5, y: 0, width: SIZE, height: SIZE, mask: false },
};

const OUTLINE = '#0f1318';
const LIGHT = '#f4f7fb';

let cached: string | null = null;

export function getIconAtlas(): string {
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * NAMES.length;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 화살표 (오른쪽 방향, 마스크 아이콘 — 색은 레이어에서 입힌다)
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(12, 10);
  ctx.lineTo(56, 32);
  ctx.lineTo(12, 54);
  ctx.lineTo(24, 32);
  ctx.closePath();
  ctx.fill();

  // 수원지: 수면이 있는 저수조
  ctx.save();
  ctx.translate(SIZE, 0);
  ctx.fillStyle = '#3987e5';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(8, 16);
  ctx.lineTo(8, 52);
  ctx.lineTo(56, 52);
  ctx.lineTo(56, 16);
  ctx.lineTo(48, 16);
  ctx.lineTo(48, 26);
  ctx.lineTo(16, 26);
  ctx.lineTo(16, 16);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.strokeStyle = LIGHT;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(18, 38);
  ctx.quadraticCurveTo(25, 32, 32, 38);
  ctx.quadraticCurveTo(39, 44, 46, 38);
  ctx.stroke();
  ctx.restore();

  // 배수지: 원통형 탱크
  ctx.save();
  ctx.translate(SIZE * 2, 0);
  ctx.fillStyle = '#22b8cf';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(12, 20);
  ctx.lineTo(12, 46);
  ctx.bezierCurveTo(12, 58, 52, 58, 52, 46);
  ctx.lineTo(52, 20);
  ctx.bezierCurveTo(52, 8, 12, 8, 12, 20);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.strokeStyle = LIGHT;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(12, 20);
  ctx.bezierCurveTo(12, 32, 52, 32, 52, 20);
  ctx.stroke();
  ctx.restore();

  // 펌프: 원 안의 삼각형
  ctx.save();
  ctx.translate(SIZE * 3, 0);
  ctx.fillStyle = '#fab219';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(32, 32, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = OUTLINE;
  ctx.beginPath();
  ctx.moveTo(24, 20);
  ctx.lineTo(46, 32);
  ctx.lineTo(24, 44);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 밸브: 나비넥타이 모양
  ctx.save();
  ctx.translate(SIZE * 4, 0);
  ctx.fillStyle = '#b094f0';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(8, 14);
  ctx.lineTo(32, 32);
  ctx.lineTo(8, 50);
  ctx.closePath();
  ctx.moveTo(56, 14);
  ctx.lineTo(32, 32);
  ctx.lineTo(56, 50);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();

  // 방류구(하수): 아래로 향한 삼각형 + 수면선
  ctx.save();
  ctx.translate(SIZE * 5, 0);
  ctx.fillStyle = '#ec835a';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(8, 10);
  ctx.lineTo(56, 10);
  ctx.lineTo(32, 46);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.strokeStyle = LIGHT;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(12, 56);
  ctx.lineTo(52, 56);
  ctx.stroke();
  ctx.restore();

  cached = canvas.toDataURL('image/png');
  return cached;
}
