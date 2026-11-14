/** 외부 자료 받는 곳 안내 링크 (수치지형도, 브이월드 인증키). 새 탭으로 연다. */
import { ExternalLink } from 'lucide-react';

const LINK = 'inline-flex items-center gap-0.5 text-accent hover:underline';

export const NGII_URL = 'https://map.ngii.go.kr/';
export const VWORLD_KEY_URL = 'https://www.vworld.kr/dev/v4dv_apikey_s001.do';

export function NgiiLink() {
  return (
    <span className="block">
      수치지형도 받는 곳:{' '}
      <a className={LINK} href={NGII_URL} target="_blank" rel="noreferrer">
        국토정보플랫폼 <ExternalLink size={10} />
      </a>{' '}
      → 국토정보맵 → 통합지도검색 → 지역 고르기 → 수치지도(1:1,000 또는 1:5,000, DXF·SHP) 다운로드. 회원 가입 후 무료(일부는 신청·승인 필요).
    </span>
  );
}

export function VworldKeyLink() {
  return (
    <span className="block">
      인증키 받는 곳:{' '}
      <a className={LINK} href={VWORLD_KEY_URL} target="_blank" rel="noreferrer">
        브이월드 오픈API 인증키 발급 <ExternalLink size={10} />
      </a>{' '}
      (로그인 → 인증키 발급 → 서비스 URL 에 이 사이트 주소를 넣고, WMTS 배경지도를 고르세요). 무료입니다.
    </span>
  );
}
