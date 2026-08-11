# 루멘문

모바일·데스크톱 브라우저에서 실행되는 1인칭 비동기 공동 복셀 건축 게임입니다. 별도 게임 서버 없이 정적 클라이언트와 선택적인 Supabase Postgres RPC만 사용합니다.

## 로컬 실행

필수 환경은 Node.js와 npm입니다.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

`.env.local`에서 `VITE_REPOSITORY_MODE=local`을 유지하면 IndexedDB에 단일 로컬 월드를 저장합니다. 데스크톱은 WASD·마우스·클릭, 모바일은 왼쪽 이동 스틱·오른쪽 시점 드래그·화면 버튼을 사용합니다.

## local / online 모드

모드는 반드시 명시하며, 잘못된 온라인 설정을 로컬 월드로 자동 전환하지 않습니다.

```dotenv
# 브라우저 한 대의 IndexedDB 월드
VITE_REPOSITORY_MODE=local

# 또는 Supabase 비동기 공동 월드
VITE_REPOSITORY_MODE=online
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable 또는 anon 키>
VITE_SUPABASE_WORLD_ID=00000000-0000-4000-8000-000000000001
```

`VITE_` 변수는 브라우저 번들에 공개됩니다. publishable/anon 키만 넣고 service-role·secret 키, 인증 토큰을 넣지 마세요. 앱은 service-role 형식과 의심되는 브라우저 secret 변수를 시작 단계에서 거부합니다. 분석 환경 변수와 동의 정책은 [docs/analytics.md](docs/analytics.md)를 따릅니다.

## 로컬 Supabase와 데이터베이스

Docker Desktop을 실행한 뒤 프로젝트에 포함된 CLI로 migration과 seed를 적용합니다.

```powershell
npm run db:start
npm run db:reset
npm run test:db
```

`db:reset`은 `supabase/migrations`를 순서대로 적용하고 `supabase/seed.sql`의 단일 월드와 첫 `루멘문`을 생성합니다. 로컬 API URL과 anon 키 확인, 익명 인증 및 HTTP 통합 테스트 절차는 [docs/supabase-local.md](docs/supabase-local.md)에 있습니다.

재고·생산 시각·베이 슬롯·블록 소유권·미션 기여는 공개 테이블 쓰기가 아니라 인증된 RPC에서 검증합니다. 월드 commit은 최대 24작업·32KiB이며 블록 종류, 12색, 회전, 정수 좌표, 구역 권한과 support 관계를 서버에서도 검사합니다. 동일 멱등 키는 동일 payload만 재생할 수 있어 응답 유실이나 재시도로 재고와 기여가 중복되지 않습니다.

## 정적 클라이언트 빌드

```powershell
npm run typecheck
npm run build
```

결과물은 `dist/`에 생성됩니다. SPA fallback이 필요 없는 단일 진입점이므로 HTTPS 정적 호스팅에 올릴 수 있습니다. 이 저장소 작업에서는 배포 설정을 포함하지 않습니다.

## 비용을 낮추는 구조

- Realtime, WebSocket, Edge Function, 별도 Node 서버와 상시 폴링을 사용하지 않습니다.
- 주변 청크는 입장·청크 이동·탭 복귀 시에만 읽습니다. 16³ 청크 기준 가로 반경 2, 수직 반경 1만 조회하며 8,192블록을 넘는 과밀 응답은 부분 로드하지 않고 오류로 중단합니다.
- 생산은 크론 없이 마지막 서버 정산 시각과 DB `now()`로 계산합니다.
- 4방향 미션 복제는 원본 24슬롯만 저장하고 클라이언트가 렌더링합니다.
- 3D 기념물은 관람 층 주변 최대 5개만, 기록관 응답은 최근 완료 50개만 불러옵니다.
- 제품 분석은 명시적 동의 뒤 요약 이벤트만 전송하며 세션당 20건으로 제한합니다.

Supabase·PostHog 무료 플랜에는 월별 사용량 제한과 비활성 프로젝트 일시 중지 정책이 있을 수 있습니다. 운영 전 각 공급자 대시보드에서 현재 한도·알림·복구 방법을 확인해야 하며, 프로젝트가 중지된 동안에는 온라인 월드 이용을 보장할 수 없습니다.

Realtime을 사용하지 않는 이유는 저트래픽 비동기 건축에서 실시간 접속 상태보다 다음 방문자가 이전 결과를 확실히 읽는 것이 핵심이고, 지속 연결 비용과 모바일 백그라운드 복구 복잡도를 피하기 위해서입니다. 탭 복귀 때 주변 블록·재고·생산·활성 미션을 다시 조회합니다.

## 익명 계정과 개인정보

온라인 계정은 Supabase 익명 세션에 묶입니다. 사이트 데이터·쿠키·브라우저 저장소를 삭제하거나 다른 브라우저·기기로 옮기면 같은 베이와 기여 계정을 복구할 수 없습니다. 현재 계정 연결·백업 기능은 없습니다.

공개 제작자 정보는 고정 공개 ID, 허용 목록 조합 닉네임, 문양뿐입니다. 내부 auth UID·토큰·IP는 게임 공개 응답이나 애플리케이션 분석 테이블에 저장하지 않습니다.

## 검증

```powershell
npm run lint
npm run typecheck
npm test
npm run db:reset
npm run test:db
npm run build
```

실제 로컬 Supabase HTTP 통합 테스트는 비밀값을 출력하지 않고 `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`를 현재 셸에 설정한 뒤 `npm run test:db:client`로 실행합니다.

## 알려진 MVP 제한

- 익명 계정 복구·기기 이전이 없습니다.
- 서버 중지·무료 플랜 일시 중지 중에는 온라인 기능을 사용할 수 없습니다.
- 네트워크 변경은 12초에 타임아웃됩니다. 멱등 변경 호출부는 같은 action과 키로 한 번만 재시도하며, 계속 실패하면 재시도/새로고침 안내가 표시됩니다.
- Realtime이 없어 다른 사용자의 변경은 청크 재진입 또는 탭 복귀 때 확인합니다.
- 한 번의 주변 조회가 8,192블록을 넘는 과밀 구역은 불완전한 충돌 상태를 보여주지 않기 위해 진입 동기화가 거절됩니다.
- 완료 기록은 DB에 보존되지만 MVP 기록관 UI는 최근 50개까지만 보여 주며 페이지 이동은 아직 없습니다.
- 블록과 멱등 operation 기록의 장기 압축·보관 만료 정책은 아직 없어, 운영 데이터가 커지면 별도 유지보수 정책이 필요합니다.
- 실시간 플레이어, 채팅, 전투, 거래, 랭킹과 결제는 범위 밖입니다.
- 실제 모바일 기종별 FPS와 장시간 대규모 월드 부하는 별도 현장 측정이 필요합니다.

