# 저비용 제품 분석 운영 계약

## 목적과 데이터 경계

이 게임은 두 종류의 수치를 명확히 분리한다.

- PostHog Cloud: 사용자의 동의를 받은 뒤 익명 기기 단위로 첫 플레이 퍼널, 체류, 재방문, 품질 구간을 본다.
- Supabase: 검증 RPC가 확정한 방문, 블록 배치·철거, 생산시설 진행, 수동 생산, 공동 기여와 미션 완료만 센다.

Supabase에 클릭·키보드·마우스·터치·이동·시점·페이지 이벤트를 저장하는 테이블을 만들지 않는다. PostHog 이벤트나 webhook도 Supabase로 복제하지 않는다. 분석 실패는 게임 저장·렌더링·RPC 재시도의 이유가 될 수 없다.

## 활성화와 동의

필요한 환경 변수는 다음 세 개다.

```dotenv
VITE_ANALYTICS_ENABLED=false
VITE_POSTHOG_KEY=
VITE_POSTHOG_HOST=https://eu.i.posthog.com
```

- 개발·테스트의 기본값은 `false`이며 `NoopAnalytics`를 사용한다.
- 세 변수가 준비되어도 사용자가 설정 화면에서 `익명 이용 통계`에 동의하기 전에는 SDK를 import·초기화하거나 네트워크 요청을 보내지 않는다.
- localhost, Vitest, Playwright/E2E 표식이 있는 실행은 동의 여부와 무관하게 외부 전송을 막는다.
- 철회하면 즉시 `NoopAnalytics`로 교체하고 미전송 델타·임시 제작자 집합을 버린다. PostHog 식별자를 `reset(true)`로 초기화한 다음 opt-out을 마지막 상태로 다시 고정하며, 철회 구간의 행동은 재동의 뒤에도 소급 전송하지 않는다.
- Supabase auth UID, 공개 ID, 닉네임으로 `identify()`하지 않는다. 초기 리텐션은 PostHog가 동의 후 만든 익명 기기 ID만 사용하므로 계정·사람 단위 지표로 해석하지 않는다.
- production과 staging은 서로 다른 PostHog project/key를 사용한다. 모든 허용 이벤트에는 추가 방어용 `environment` enum을 넣는다.

초기화 옵션은 다음 값을 고정한다.

```ts
{
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  capture_performance: false,
  disable_session_recording: true,
  person_profiles: 'identified_only',
  respect_dnt: true,
  mask_all_text: true,
  mask_all_element_attributes: true,
}
```

세션 리플레이는 별도의 목적 설명과 별도 동의를 구현하기 전까지 항상 꺼 둔다. autocapture, 히트맵, 자유 텍스트 설문, 광고 추적도 활성화하지 않는다.

## 개인정보 안내 문안

설정 화면에는 다음 내용을 짧게 표시하고 이 문서로 연결한다.

> 동의하면 분석 공급자 PostHog Cloud를 통해 익명 기기 기준의 게임 시작, 최초 달성 단계, 5분 단위 이용 요약, 허용된 오류 코드만 수집합니다. 게임 개선과 오류율 확인에만 사용하며 닉네임·공개 ID·정확한 위치·채팅·입력 기록·세션 화면은 수집하지 않습니다. 설정에서 언제든 끌 수 있습니다.

애플리케이션 속성으로 다음 값을 절대 보내지 않는다.

- Supabase auth UID, 공개 ID, 닉네임, 문양과 조합 가능한 개인 식별 문자열
- IP 또는 `$ip` 속성
- 정확한 월드 좌표, 시점 각도, 블록 ID, 미션 instance ID
- 자유 텍스트와 DOM 텍스트
- 전체 URL, path/query string, referrer URL
- 원본 user agent
- 인증 토큰, PostHog/Supabase key, 환경 변수
- 원본 오류 message, cause, stack trace

브라우저가 Cloud 사업자에게 요청할 때 생기는 네트워크 메타데이터의 처리는 PostHog의 개인정보 정책·DPA와 선택한 US/EU 리전을 별도로 검토한다. 앱은 IP를 이벤트 속성이나 Supabase 테이블에 명시적으로 기록하지 않는다.

`before_send` 최종 필터는 허용된 이벤트 이름·속성·enum·자료형·길이만 새 객체로 복사한다. 금지 키를 지우는 denylist만으로 통과시키지 않는다. 필터 이후 JSON UTF-8 크기가 4KB를 넘거나 URL·좌표·UID 형태가 감지되면 이벤트 전체를 버린다.

## 이벤트 계약

공통 속성은 `environment: production | staging | development | test`만 허용한다. PostHog 외부 전송에는 production·staging만 사용하고 development·test는 `MemoryAnalytics` 검증용이다. 이벤트 이름은 다음 네 개뿐이다.

### `game_session_started`

월드가 실제 조작 가능한 시점에 세션당 한 번 전송한다.

- `first_visit: boolean`
- `progress_stage: new_player | base_in_progress | base_completed | producer_completed | mission_contributor`
- `device_class: mobile | desktop | tablet`
- `input_mode: touch | keyboard_mouse`
- `orientation: portrait | landscape`
- `app_version: string` — 빌드에 포함된 짧은 버전만 사용
- `acquisition: direct | search | social | referral | unknown` — referrer 원문·hostname은 버리고 분류 결과만 사용
- `world_ready_ms_bucket: under_1s | 1s_to_3s | 3s_to_10s | over_10s`
- `renderer_tier_bucket: low | medium | high | unknown`

### `player_milestone_reached`

각 milestone을 익명 기기의 생애 최초 한 번만 전송하며 완료 집합은 IndexedDB에 저장한다.

- `milestone`: `first_move | first_block | base_completed | producer_completed | first_manual_production | first_other_creator_seen | first_creator_highlight | first_mission_contribution`
- `time_from_first_session_seconds: number` — 0 이상의 정수, 상한 적용
- `device_class: mobile | desktop | tablet`

### `game_session_summary`

5분마다, 그리고 `pagehide`·정상 종료 때 직전 성공 전송 이후의 델타만 보낸다. 델타가 없더라도 최종 종료 표식이 필요할 때만 전송한다.

- 시간: `active_seconds`, `wall_seconds`, `personal_zone_seconds`, `producer_zone_seconds`, `mission_zone_seconds`, `public_zone_seconds`, `archive_seconds`
- 행동 합계: `personal_blocks_placed`, `public_blocks_placed`, `mission_blocks_placed`, `own_blocks_removed`, `foreign_blocks_removed`, `manual_production_count`, `creator_card_view_count`, `creator_highlight_count`, `archive_open_count`, `mission_contribution_count`, `insufficient_inventory_count`, `commit_failure_count`, `context_loss_count`
- 구간·순서: `distinct_other_creators_seen_bucket: 0 | 1 | 2_to_4 | 5_to_9 | 10_plus`, `average_fps_bucket: under_20 | 20_to_39 | 40_to_54 | 55_plus | unknown`, `summary_sequence: number`, `final_summary: boolean`

같은 `summary_sequence`는 한 번만 전송한다. `pagehide` 전송은 유실될 수 있으므로 5분 체크포인트가 기본 복구 경계다.

### `game_failure`

- `code`: `webgl_unsupported | webgl_context_lost | repository_bootstrap_failed | world_sync_failed | commit_rejected | commit_network_failed | production_failed | mission_contribution_failed | storage_failed`
- `stage`: `boot | renderer | world_read | world_write | production | mission`
- `recoverable: boolean`
- `retry_succeeded: boolean`
- `device_class: mobile | desktop | tablet`

오류 객체를 spread하지 않고 호출자가 위 코드로 매핑한 값만 받는다. 원본 오류 문자열과 stack은 로컬 개발 로그에만 남긴다.

## 활성 시간과 구역 체류

- `document.visibilityState === 'visible'`이고 키보드·마우스·터치 입력 후 60초 이내인 시간만 `active_seconds`에 더한다.
- 숨겨진 탭과 60초 무입력 구간은 wall time에는 포함할 수 있지만 active time에는 포함하지 않는다.
- 이동 좌표, 시점 각도와 입력 스트림은 저장·전송하지 않는다.
- 현재 좌표는 메모리에서 기존 월드 구역 판정에 넣은 뒤 `personal | producer | mission | public | archive` 누적 초만 남긴다.
- 기록관 DOM이 열린 시간은 `archive_seconds`로 분류하며 다른 구역과 중복 합산하지 않는다.
- 평균 FPS도 개별 frame sample을 보내지 않고 세션 요약의 구간 하나로만 보낸다.

## 비용 방어와 운영 체크리스트

앱의 강제 상한은 세션당 20 events, 필터 이후 이벤트당 4KB다. 이동·시점·클릭·frame은 전송하지 않으며 카운터로 합친다. 마일스톤 8개는 기기 생애 한 번뿐이다. 일반적인 재방문 5분 미만 세션은 시작+최종 요약 약 2건, 10분 첫 플레이는 시작+달성 마일스톤+체크포인트를 합쳐 대체로 6~12건이다. 어떤 경우에도 20건을 넘지 않는다.

PostHog 공식 가격 페이지는 2026-08-11 확인 시 Product Analytics 월 100만 events 무료 구간을 안내한다. 가격과 정책은 바뀔 수 있으므로 [PostHog 공식 가격](https://posthog.com/pricing)과 프로젝트의 실제 Billing/Usage 화면을 운영 시점의 기준으로 삼는다.

매주 다음을 확인한다.

- Billing/Usage의 당월 Product Analytics 사용량, 예상 월말 사용량, 결제수단·spend limit 상태를 확인한다.
- 프로젝트에서 Session Replay 수집량이 0인지 확인한다.
- 이벤트 목록이 네 종류뿐인지, `$pageview`, `$pageleave`, `$autocapture`가 0인지 확인한다.
- 운영 대시보드에는 `environment=production` 필터가 고정되어 있는지 확인한다.
- 현재 무료 한도의 70% 도달: 원인 이벤트·봇/중복 여부를 확인하고 `game_failure` 예산과 체크포인트 빈도를 검토한다. 새 이벤트를 추가하지 않는다.
- 90% 도달 또는 월말 예측 100% 초과: `VITE_ANALYTICS_ENABLED=false`로 다음 정적 배포에서 전송을 중단한다. 공급자 설정에 hard limit가 제공되면 무료 한도를 넘지 않도록 함께 설정한다.
- 유료 전환·결제수단 등록은 별도 승인 없이는 하지 않는다. 현재 한도·알림 설정을 변경한 날짜와 담당자를 운영 기록에 남긴다.

최악의 20건/세션 기준으로 월 100만 events는 5만 세션에 해당한다. 이는 보장된 무료량이 아니라 앱 상한을 이용한 용량 추정이며, 공급자 현재 정책과 실제 사용량이 우선한다.

## PostHog 대시보드 정의

모든 chart는 `environment=production`과 동의 이후 이벤트만 사용한다. 트래픽이 적을 때 비율만 표시하지 말고 제목 또는 표에 항상 `분자 / 분모`와 관측 기간을 함께 표시한다. 작은 표본은 통계적 결론이 아니라 방향성으로 표시한다.

### 1. 첫 플레이 퍼널

순서는 다음과 같다.

```text
game_session_started
→ first_move
→ first_block
→ base_completed
→ producer_completed
→ first_other_creator_seen
→ first_mission_contribution
```

- 시작은 `game_session_started`, 나머지는 `player_milestone_reached.milestone` 조건을 사용한다.
- 각 단계에 고유 익명 기기 수, 이전 단계 대비 `도달 기기 / 이전 단계 기기`, 시작 대비 `도달 기기 / 시작 기기`, 중앙 소요 시간을 표시한다.
- `device_class`와 `first_visit=true`를 breakdown으로 제공하되 소표본에서는 합계를 함께 표시한다.

### 2. 온라인 경험

- 주간 연결 건축자: 같은 주에 `first_other_creator_seen` 또는 `creator_card_view_count > 0`이 있고, summary에서 개인·공용 블록 배치 합계 또는 `mission_contribution_count`가 1 이상인 고유 익명 기기다.
- 타인 결과물 인지율: `타인 제작자 milestone 또는 카드 확인 기기 / 조작 가능한 세션 시작 기기`.
- 타인 제작자 확인까지 걸린 시간: `first_other_creator_seen.time_from_first_session_seconds` 중앙값과 표본 수.
- 제작자 확인 후 공동 기여 전환율: 확인 뒤 같은 기기에서 `first_mission_contribution`에 도달한 기기 / 제작자를 확인한 기기.
- 재방문 차이: 제작자를 본 cohort와 보지 않은 cohort의 D1·D7 재방문 `재방문 기기 / cohort 기기`를 나란히 표시한다.

### 3. 리텐션과 품질

- DAU·WAU·MAU: `game_session_started`의 고유 익명 기기. 계정 사용자 수로 부르지 않는다.
- D1·D7·D30 리텐션: 첫 `game_session_started` cohort의 해당 날짜 재시작 기기 / cohort 기기.
- 중앙 활성 시간과 2분 이상 세션 비율: summary delta를 `summary_sequence`별 합산한 세션 단위 값으로 계산한다.
- 모바일·태블릿·데스크톱 첫 플레이 퍼널의 단계별 분자/분모를 비교한다.
- `world_ready_ms_bucket`, `renderer_tier_bucket`, `average_fps_bucket` 분포와 각 bucket의 세션 수를 표시한다.
- 저장 실패율: `commit_failure_count > 0 세션 / world write 시도 세션`; 재시도 성공률은 `retry_succeeded=true failure / recoverable failure`로 표시한다.
- WebGL 미지원률은 `webgl_unsupported / 분석 동의 후 boot 시도`, context loss율은 `context_loss_count > 0 세션 / renderer가 시작된 세션`으로 표시한다.

## Supabase 운영자 전용 확정 지표

Migration 005는 `player_world_state`에 30분 무활동 경계로 합친 성공 bootstrap 방문 수와 RPC 트랜잭션에 포함된 누적 배치·철거·자동·수동 생산 수만 추가한다. 복구나 미션 재조회 때문에 같은 플레이 세션에서 bootstrap을 반복해도 방문 수를 늘리지 않으며 `last_joined_at`만 갱신한다. 블록 insert/delete와 완료된 manual-production idempotency row의 DB trigger가 같은 트랜잭션에서 카운터를 갱신하고, 자동 생산은 기존 DB-clock 정산 함수가 실제 산출량만 함께 더한다. 따라서 별도 분석 요청과 이중 성공 상태가 없다.

이미 정규 데이터로 계산 가능한 다음 값은 중복 컬럼을 만들지 않는다.

- 최초 사용자·거점·생산시설 완료·업그레이드: `player_world_state`의 생성·완료 timestamp
- 첫 공동 기여와 기여 수: `mission_contributions`
- 미션 완료 시각과 완료 시간: `mission_instances`
- 현재 존재하는 블록과 제작 시각: `blocks`

운영 뷰는 `private.operator_world_metrics`, `private.operator_mission_metrics` 두 개다. `service_role`만 `private` schema usage와 SELECT를 가지며 `anon`·`authenticated`는 직접 조회하거나 쓸 수 없다. 브라우저에 service-role key를 넣지 말고 Supabase SQL Editor 또는 별도 승인된 운영 작업에서만 아래 SQL을 실행한다.

```sql
-- 세계별 신규/재방문, 확정 배치·철거, 시설과 공동 기여 누계
select *
from private.operator_world_metrics
order by world_slug;

-- 공동 미션별 고유 기여자, 정규 기여 수, 완료 시간
select *
from private.operator_mission_metrics
order by world_id, layer;
```

기간별 신규·최근 재방문은 개인 행을 반환하지 않는 집계 SQL로 확인한다. `last_joined_at`은 마지막 성공 bootstrap만 보존하므로 기간 안의 모든 방문 이력을 재구성하는 이벤트 로그가 아니며, 세션 리텐션은 PostHog를 기준으로 한다.

```sql
with bounds as (
  select :from_at::timestamptz as from_at, :to_at::timestamptz as to_at
)
select state.world_id,
       count(*) filter (
         where state.created_at >= bounds.from_at
           and state.created_at < bounds.to_at
       ) as new_players,
       count(*) filter (
         where state.created_at < bounds.from_at
           and state.last_joined_at >= bounds.from_at
           and state.last_joined_at < bounds.to_at
           and state.join_count > 1
       ) as recently_returned_players
  from public.player_world_state as state
 cross join bounds
 group by state.world_id;
```

```sql
-- 완료 timestamp와 누적 카운터만 사용하는 생산시설 운영 현황
select world_id,
       count(*) filter (where producer_completed_at is not null) as completed_producers,
       count(*) filter (where producer_upgrade_completed_at is not null) as upgraded_producers,
       sum(total_automatic_produced) as confirmed_automatic_production,
       sum(total_manual_produced) as confirmed_manual_production
  from public.player_world_state
 group by world_id;
```

Migration 005를 이미 운영 중인 DB에 적용하면 현재 남아 있는 블록 수와 최근 24시간 수동 생산 배열만 초기 baseline으로 복구할 수 있고, 과거에 삭제된 블록, 과거 자동 생산량과 배열에서 만료된 수동 생산은 역산할 수 없다. 신규 배포·DB reset 이후 수치는 처음부터 정확하며, 기존 운영 DB에서는 migration 적용 시점을 지표 기준선으로 기록한다.
