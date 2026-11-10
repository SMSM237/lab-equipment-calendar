# 장비 캘린더

장비별 예약과 사용 가능 시간을 공유하는 웹 캘린더입니다. 한국 시간(KST)을 기준으로 하며, 장비마다 색상을 지정할 수 있습니다.

개발자: **smsm**

## 기능

- 월·주·일 보기와 모바일 화면, 장비별 색상 및 필터
- 사용자 이름과 시작·종료 시간을 표시하는 예약
- 날짜를 넘기는 예약과 남은 사용 가능 시간 표시
- 서버에서 중복 예약을 검사하고, 종료 시각부터 다음 예약 허용
- Google 로그인, 최초 이름 확인과 기기별 로그인 유지
- 모바일 날짜 선택으로 예약 입력, 날짜·요일 자동 표시

## 구성

| 경로 | 내용 |
| --- | --- |
| `cloud/frontend` | Vercel 프런트엔드와 Cloudflare Worker로 요청을 전달하는 게이트웨이 |
| `cloud/worker` | Cloudflare Workers API, D1 스키마와 설정 예시 |
| `self-hosted` | Python 표준 라이브러리와 SQLite를 사용하는 자체 호스팅 버전 |
| `tests` | 예약 충돌, 로그인과 날짜 이동 등에 대한 자동 검사 |

클라우드와 자체 호스팅 버전은 별도의 저장소를 사용하며 데이터가 자동 동기화되지 않습니다. 실제 예약 데이터, 계정별 설정, 로그인 비밀값과 서버 주소는 포함하지 않았습니다.

## 자체 호스팅 시험

Python 3을 설치한 뒤 다음과 같이 실행합니다. 아래 명령은 현재 PC에서만 접속합니다.

```bash
cd self-hosted
python server.py --host 127.0.0.1 --port 8765
```

브라우저에서 `http://localhost:8765`를 열고 시험용 이름으로 로그인한 뒤 장비를 추가합니다. 이름만 입력하는 기본 시험 모드는 신원 확인이 없으므로 실제 예약 운영에 사용하면 안 됩니다. Google 로그인과 HTTPS 설정은 [자체 호스팅 안내](self-hosted/README.md)를 참고하세요.

## 클라우드 구성

클라우드 배포는 별도의 Cloudflare, Vercel, Google Cloud 설정이 필요합니다.

1. Cloudflare D1 데이터베이스를 새로 만들고 `cloud/worker/schema.sql`을 적용합니다. Worker에는 데이터베이스를 `DB`로 바인딩합니다.
2. `cloud/worker/wrangler.example.toml`을 복사하여 본인의 Worker와 D1 설정을 준비합니다. 예시는 접근 허용 목록을 비워 두므로 목록을 설정하기 전에는 로그인이 허용되지 않습니다.
3. Worker에 `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`을 설정합니다. Google 비밀값은 소스에 기록하지 말고 서비스의 비밀값 저장 기능을 사용하세요. Google OAuth의 반환 주소는 `https://사용할-프런트엔드-주소/auth/google/callback`입니다.
4. Worker의 `ACCESS_POLICY`를 `all`로 설정하면 인증된 모든 Google 계정을 허용합니다. 특정 사용자만 허용하려면 `restricted`와 함께 `ALLOWED_EMAILS` 또는 `ALLOWED_GOOGLE_DOMAINS`를 지정하세요. 허용된 모든 사용자는 공유 예약을 볼 수 있습니다.
5. Vercel의 프로젝트 루트를 `cloud/frontend`로 설정하고, `WORKER_ORIGIN` 환경 변수에 본인의 `https://...workers.dev` 원본 주소를 설정합니다. 현재 게이트웨이는 다른 Worker 도메인을 허용하지 않습니다.

설정 예시는 새 환경을 위한 것입니다. Google 동의 화면 상태, 사용자의 접근 권한, 백업·복원과 실제 배포는 각 환경에서 확인해야 합니다. 새 저장소를 기존 운영 서비스에 연결하거나 배포하는 작업은 별도입니다.

## 검사

다음 명령은 저장소의 가상 사용자와 임시 데이터만 사용합니다. Node.js 24 및 Python 3.13에서 실행했습니다.

```bash
node --test tests/test_today_motion.mjs tests/test_cloud_worker.mjs
python -m unittest discover -s tests -p "test_*.py"
```

## 글꼴

화면에 포함된 Wanted Sans의 라이선스는 각 프런트엔드의 `OFL.txt`를 참고하세요.
