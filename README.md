# MuxDesk · v1.0.0

Windows ConPTY 기반의 지속형 터미널 워크스페이스입니다. 터미널 분할, SSH 접속, 저장 명령어, 사용자 단축키와 내장 브라우저를 지원합니다. 개인 설정은 배포 소스에 포함하지 않습니다.

## 빌드와 배포 검증

Windows x64와 Node.js 22 이상에서 실행합니다. 소스와 산출물은 이 프로젝트에서 관리하며 `.env/`, `node_modules/`, `release/`는 Git에서 제외합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-release.ps1
```

설치, 공개 파일 검사, 테스트, 전체 취약점 감사, portable EXE 빌드, 패키지 무결성, 실제 ConPTY 및 GUI 시작을 차례로 검증합니다. 모두 통과해야 `.env/pre-release.json`과 `release/cmux-v1.0.0.exe.sha256`이 생성됩니다. 어느 단계든 실패하면 공개 배포 준비가 완료된 상태가 아닙니다.

결과는 단일 실행 파일 `release/cmux-v1.0.0.exe`입니다. 더블 클릭하거나 `npm start`로 실행합니다. Windows x64 Node-API 바이너리를 사용하며 빌드 중 node-pty를 재컴파일하지 않습니다. 실행 파일에는 앱 소스와 필요한 런타임만 포함합니다.

검사 스크립트만 바뀌었고 기존 EXE가 소스·의존성과 일치하면 재설치와 빌드를 생략할 수 있습니다. 나머지 검증은 그대로 수행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-release.ps1 -ResumeBuild
```

의존성은 잠금 파일로 관리합니다. 설치는 `npm ci`를 사용하며 감사에서 low 이상 문제가 발견되면 배포를 중단합니다.

## Linux 공유폴더와 Windows 실행

Linux 서버의 프로젝트를 Windows 공유 드라이브로 접근해 빌드할 수 있습니다. Windows GUI는 Windows 컴퓨터의 GPU를 사용합니다.

공유 드라이브의 `release/win-unpacked/cmux.exe`를 직접 실행하면 Chromium의 샌드박스 자식 프로세스 생성이 실패할 수 있습니다. 실제 배포용 portable EXE는 Windows 로컬 임시 디렉터리에 런타임을 풀어 실행합니다. GUI 검증도 이 portable EXE를 실행하며, 빌드용으로 지정한 공유폴더 TEMP를 실행 프로세스에 전달하지 않습니다. [Electron의 동일 오류 보고](https://github.com/electron/electron/issues/36698)를 참고하세요.

GUI 검증에 필요한 런타임·빈 프로필·Chromium 캐시는 Windows의 `%LOCALAPPDATA%\Temp\cmux-smoke-*`에 일시적으로 생성하고 검사 종료 시 제거합니다. 결과와 앱 로그는 프로젝트 `.env/`에 보존합니다. 서버 홈 디렉터리에는 산출물을 생성하지 않습니다. 빌드용 캐시·임시 파일은 프로젝트 `.env/cache/`에 유지합니다. 공유폴더에서 `npm run dev`로 Electron을 직접 실행하는 방식은 이 실행 조건을 만족하지 않습니다.

## 소스 구조

- `src/`: 메인 프로세스, 터미널 데몬, UI
- `test/`: 개인 설정·보안·클립보드·데몬 검증. EXE에는 포함하지 않음
- `scripts/`: 설치·빌드·배포 검사와 자동 기록
- `.github/workflows/windows.yml`: Windows 검증과 태그 기반 GitHub Release
- `package.json`, `package-lock.json`: 버전과 재현 가능한 의존성 설치
- `.env/`: 비공개 설정, 기록, 빌드 캐시

`src/`와 검증 코드는 소스 배포에 필요합니다. `node_modules/`와 `release/`는 생성 파일이며 실행 파일은 GitHub Releases에서 관리합니다.

## 개인 설정

`.env`는 환경 변수 텍스트 파일이 아닌 비공개 디렉터리입니다. 개발 실행은 프로젝트 `.env/`, 배포 실행은 `%APPDATA%\cmux-public-v1\.env\`를 사용합니다. `CMUX_PRIVATE_DIR`로 별도 경로를 지정할 수 있으며 해당 경로의 `runtime/`에 Chromium 데이터를 저장하므로 Windows 로컬 경로를 사용하세요.

`profile.json`에는 SSH 호스트·사용자·키 경로, 저장 명령어, 단축키와 레이아웃을 저장합니다. 이 파일은 암호화되지 않습니다. 비밀번호는 `ssh-credentials.json`에 Windows 사용자 계정으로 암호화해 저장하며 개인키는 SSH 디렉터리에서 관리합니다. 빈 SSH·명령어 목록과 기본 단축키로 시작합니다.

## 실행 결과 자동 저장

배포 검사는 실행별 `.env/run-logs/<실행 ID>/`에 단계별 종료 코드와 출력, 감사 결과 및 실패 내용을 저장합니다. 최신 기록은 `.env/latest-release.json`입니다. 공개 파일 목록은 `.env/upload-files.txt`에 저장합니다.

GUI 검증의 `app.stdout.log`, `app.stderr.log`, `application.jsonl`도 실행 로그에 보존합니다. 앱 자체 진단은 개인 설정 디렉터리의 `logs/application.jsonl`에 기록하며 크기를 제한합니다. 오류 원인은 상위 PowerShell의 일반적인 `exit 1` 메시지 대신 해당 단계와 앱 로그에서 확인합니다.

## 사용법과 GitHub

워크스페이스 탭과 패널을 드래그해 순서와 분할을 변경합니다. Ctrl+1~9로 워크스페이스를 이동합니다. 터미널 선택은 자동 복사하며 TUI에서는 Shift+드래그를 사용합니다. Ctrl+C는 선택 영역이 있으면 복사하고 없으면 셸로 전달합니다. Ctrl+V / Ctrl+Shift+V로 붙여넣습니다. 설정에서 단축키를 변경하며 Ctrl+Insert로 앱 단축키를 켜고 끕니다.

창을 닫아도 터미널 데몬은 유지됩니다. 패널 삭제 시 해당 프로세스를 종료하며 Windows 재부팅 후에는 레이아웃을 복원하고 셸을 새로 생성합니다.

소스를 GitHub에 올리면 Actions가 같은 Windows 검증을 수행합니다. `package.json` 및 잠금 파일과 일치하는 `v1.0.0` 태그를 푸시하면 검증을 통과한 EXE와 체크섬을 GitHub Release에 등록합니다. `.env/`, `node_modules/`, `release/`를 수동 업로드하지 마세요.
