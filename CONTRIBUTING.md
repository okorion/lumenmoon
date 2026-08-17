# 루멘문에 기여하기

버그 제보와 작은 개선 제안을 환영합니다. 구현 범위가 큰 변경은 작업 전에 이슈에서 문제와 접근 방법을 먼저 공유해 주세요.

## 개발 환경

Node.js 22 이상과 npm을 사용합니다.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

기본 설정은 외부 서비스에 연결하지 않는 `local` 모드입니다. 온라인 개발 환경은 [Supabase 개발 문서](docs/supabase-local.md)를 참고해 별도로 구성해 주세요. 실제 키나 토큰은 커밋하지 마세요.

## 변경 제출

1. 저장소를 포크하고 변경 목적이 드러나는 브랜치를 만듭니다.
2. 기능 변경에는 관련 테스트를 추가하거나 갱신합니다.
3. 아래 검증을 모두 통과시킵니다.
4. 변경 이유와 검증 결과를 Pull Request에 적습니다. 화면이 바뀌면 같은 조건의 변경 전·후 캡처를 함께 첨부해 주세요.

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

보안 취약점은 공개 이슈나 Pull Request로 제보하지 말고 [보안 정책](SECURITY.md)을 따라 주세요.
