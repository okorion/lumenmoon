# Supabase 로컬 공동 월드 설정

## 준비물

- Node.js와 npm
- Docker Desktop
- 프로젝트 devDependency의 Supabase CLI (`npm exec -- supabase --version`)

별도 Node 서버, Edge Function, Realtime, WebSocket은 사용하지 않는다. 정적 클라이언트는 익명 인증 후 검증 RPC만 호출한다.

## 실행

1. `.env.example`을 `.env.local`로 복사한다.
2. `npm run db:start`를 실행한다.
3. `npm run db:reset`으로 migration과 `supabase/seed.sql`을 적용한다.
4. `npm exec -- supabase status -o env`에서 API URL과 anon/publishable 키를 확인한다. 이 출력에는 로컬 secret/service-role 값도 있으므로 공유하거나 커밋하지 않는다.
5. `.env.local`을 다음처럼 설정하고 `npm run dev`를 실행한다.

```dotenv
VITE_REPOSITORY_MODE=online
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<로컬 anon 또는 publishable 키>
VITE_SUPABASE_WORLD_ID=00000000-0000-4000-8000-000000000001
```

브라우저에는 anon/publishable 키만 사용한다. service-role 키는 환경 파일, 코드, 로그, 문서 예시에 넣지 않는다. 로컬 Supabase 설정에서 anonymous sign-in이 활성화돼 있어야 한다.

## 검증

```text
npm run db:reset
npm run test:db
npm run test:db:client
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

`supabase/tests/online_world.sql`은 RLS/RPC 경계와 서버 시각 규칙을 검사한다. Docker 또는 CLI를 사용할 수 없으면 DB 통합 검증을 성공으로 기록하지 않고, TypeScript 계약 테스트와 SQL 정적 검증까지만 보고한다.

`test:db:client`는 실제 익명 사용자 두 명으로 HTTP/RPC 경로를 검증한다. 실행 전에 현재 셸에 `SUPABASE_TEST_URL`과 `SUPABASE_TEST_ANON_KEY`를 설정한다. 키를 명령문, 로그, 문서에 직접 적지 말고 `supabase status -o env` 출력을 셸 내부에서 파싱해 전달한다. 환경 변수가 없으면 이 테스트 파일은 명시적으로 skip된다.

## 모드와 장애 처리

- `VITE_REPOSITORY_MODE=local`: 기존 IndexedDB 월드를 사용한다.
- `VITE_REPOSITORY_MODE=online`: Supabase 설정이 하나라도 없거나 인증·bootstrap이 실패하면 오류 화면을 표시한다.
- 온라인 실패를 별도 로컬 월드로 자동 전환하지 않는다. 사용자가 공동 월드에 저장했다고 오인할 수 있기 때문이다.
- 주변 청크는 입장·청크 이동·탭 복귀 때만 읽는다. 상시 폴링이나 Realtime 구독은 없다.
- 로컬 `supabase/config.toml`에서도 Realtime과 Edge Runtime을 비활성화한다.
- 공통 저장소 계약의 로컬 어댑터는 테스트·오프라인 플레이용이며 멱등 캐시는 현재 탭 수명에 한정된다. 새로고침·여러 탭의 권위적 중복 방지는 `idempotent_operations`를 사용하는 온라인 모드에서 보장한다.

익명 계정은 해당 브라우저 저장소의 세션에 의존한다. 사이트 데이터 삭제나 다른 브라우저·기기로의 이동 뒤에는 기존 익명 계정을 자동 복구할 수 없다.
