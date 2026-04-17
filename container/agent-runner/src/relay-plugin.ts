/**
 * nanoclaw Relay Plugin
 *
 * Telegram 봇 방식으로 nanoclaw가 직접 Relay Server에 연결합니다.
 * 별도의 Python bridge 없이, nanoclaw 컨테이너 안에서 동작합니다.
 *
 * 동작 흐름:
 *   1. Relay Server에 Socket.io로 연결 (AGENT_TOKEN 인증)
 *   2. 웹 UI에서 첫 메시지 수신 → ContainerInput으로 변환 → index.ts 쿼리 루프 시작
 *   3. 이후 메시지 → /workspace/ipc/input/*.json 파일 작성 (기존 IPC 그대로 활용)
 *   4. 쿼리 결과(ContainerOutput.result) → socket.emit('message') 로 웹 UI 전달
 *   5. 30초마다 CPU/메모리 heartbeat 전송
 *
 * 수정 없이 활용하는 기존 index.ts 기능:
 *   - MessageStream (AsyncIterable)
 *   - drainIpcInput / waitForIpcMessage / shouldClose (IPC 파일 폴링)
 *   - runQuery (Claude Agent SDK query 루프)
 *   - createPreCompactHook / createSanitizeBashHook (기존 훅 그대로)
 */

import { io, Socket } from 'socket.io-client';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── 타입 (index.ts 와 동일한 구조) ─────────────────────────────────────────

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  script?: string;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  thinking?: string;
}

// ── 환경 변수 ───────────────────────────────────────────────────────────────

const RELAY_URL = process.env.RELAY_URL || 'https://skytower.onrender.com';
const AGENT_ID = process.env.AGENT_ID || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_NAME = process.env.AGENT_NAME || 'nanoclaw';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';

const IPC_INPUT_DIR = '/workspace/ipc/relay-input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const CREDS_FILE = '/workspace/ipc/relay-credentials.json';

// ── 내부 유틸 ────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[relay-plugin] ${msg}\n`);
}

/** Node.js os 모듈 기반 시스템 지표 수집 */
function collectMetrics(): object {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPct = Math.round(((totalMem - freeMem) / totalMem) * 100);

  // CPU: 100ms 샘플링
  const cpuPct = getCpuPercent();

  return {
    cpu: cpuPct,
    mem: memPct,
    disk: 0,   // Node.js 기본 API에 disk stat 없음 (필요 시 statvfs binding 추가)
    os: process.platform,
  };
}

let _prevCpuTimes: ReturnType<typeof os.cpus> | null = null;
function getCpuPercent(): number {
  const cpus = os.cpus();
  if (!_prevCpuTimes) {
    _prevCpuTimes = cpus;
    return 0;
  }
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < cpus.length; i++) {
    const prev = _prevCpuTimes[i].times;
    const curr = cpus[i].times;
    const total = Object.values(curr).reduce((a, b) => a + b, 0)
      - Object.values(prev).reduce((a, b) => a + b, 0);
    idleDelta += curr.idle - prev.idle;
    totalDelta += total;
  }
  _prevCpuTimes = cpus;
  if (totalDelta === 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}

/** IPC 파일 작성 (기존 drainIpcInput 이 소비하는 형식) */
function writeIpcMessage(text: string): void {
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  fs.writeFileSync(
    path.join(IPC_INPUT_DIR, filename),
    JSON.stringify({ type: 'message', text }),
  );
  log(`IPC 파일 작성: ${filename} (${text.length} chars)`);
}

/** Close sentinel 작성 → index.ts 쿼리 루프 종료 */
function writeCloseSentinel(): void {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
    log('Close sentinel 작성');
  } catch { /* ignore */ }
}

// ── Agent 최초 등록 ─────────────────────────────────────────────────────────

interface RegisterResponse {
  agentId: string;
  token: string;
}

async function registerAgent(): Promise<RegisterResponse> {
  const res = await fetch(`${RELAY_URL}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: AGENT_NAME }),
  });
  if (!res.ok) {
    throw new Error(`Agent 등록 실패: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { agentId: string; token: string };
  log(`Agent 등록 완료: ${data.agentId}`);
  return data;
}

// ── 페어링 코드 생성 & QR 출력 ──────────────────────────────────────────────

async function generatePairingCode(token: string, expiresMinutes = 10): Promise<void> {
  const res = await fetch(`${RELAY_URL}/api/agents/pairing-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ expiresMinutes, maxUses: 1 }),
  });
  if (!res.ok) {
    throw new Error(`페어링 코드 생성 실패: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { code: string; pairUrl: string; expiresAt: string };

  process.stderr.write('\n' + '━'.repeat(40) + '\n');
  process.stderr.write(`  친구 추가 코드: \x1b[1;33m${data.code}\x1b[0m\n`);
  process.stderr.write(`  유효시간: ${expiresMinutes}분  (만료: ${data.expiresAt})\n`);
  process.stderr.write(`  웹 UI에서 이 코드를 입력하세요.\n`);
  process.stderr.write('━'.repeat(40) + '\n\n');
}

// ── 크리덴셜 로드/저장 ────────────────────────────────────────────────────────

interface Credentials {
  agentId: string;
  token: string;
}

function loadCredentials(): Credentials | null {
  // 환경 변수 우선
  if (AGENT_ID && AGENT_TOKEN) return { agentId: AGENT_ID, token: AGENT_TOKEN };

  // 파일 fallback
  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8')) as Credentials;
    }
  } catch { /* ignore */ }
  return null;
}

function saveCredentials(creds: Credentials): void {
  try {
    fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
    log(`크리덴셜 저장: ${CREDS_FILE}`);
  } catch (err) {
    log(`크리덴셜 저장 실패: ${err}`);
  }
}

// ── 명령 prefix 상수 ─────────────────────────────────────────────────────────

const SH_PREFIX = '!sh ';
const CLI_PREFIX = '!cli ';
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
const EXEC_TIMEOUT_MS = 60_000;           // 60s

// ── Shell 명령 실행 ──────────────────────────────────────────────────────────

function executeShell(command: string, socket: Socket, activeProcs: Set<ChildProcess>): void {
  log(`executeShell: ${command.slice(0, 120)}`);

  const child = spawn('sh', ['-c', command], {
    cwd: '/workspace',
    env: { ...process.env },
  });
  activeProcs.add(child);

  let totalBytes = 0;
  let fullOutput = '';

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    const notice = '\n[timeout: 60초 초과로 종료됨]\n';
    socket.emit('message_chunk', { text: notice });
    fullOutput += notice;
  }, EXEC_TIMEOUT_MS);

  const onData = (data: Buffer): void => {
    const text = data.toString();
    totalBytes += text.length;
    fullOutput += text;
    socket.emit('message_chunk', { text });
    if (totalBytes > MAX_OUTPUT_BYTES) {
      child.kill('SIGKILL');
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', (code: number | null) => {
    clearTimeout(timer);
    activeProcs.delete(child);
    socket.emit('message_done', {
      content: fullOutput || '(출력 없음)',
      type: 'shell',
      exitCode: code ?? -1,
    });
    log(`executeShell done: exit=${code}`);
  });

  child.on('error', (err: Error & { code?: string }) => {
    clearTimeout(timer);
    activeProcs.delete(child);
    socket.emit('message_done', {
      content: `[오류] ${err.message}`,
      type: 'shell',
      exitCode: -1,
    });
  });
}

// ── Claude CLI 실행 ──────────────────────────────────────────────────────────

function executeClaude(prompt: string, socket: Socket, activeProcs: Set<ChildProcess>): void {
  log(`executeClaude: ${prompt.slice(0, 120)}`);

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];

  const child = spawn('claude', args, {
    cwd: '/workspace',
    env: { ...process.env },
  });
  activeProcs.add(child);

  let finalText = '';
  let newSessionId: string | undefined;

  child.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'assistant') {
          const contentBlocks = (event.message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
          const text = contentBlocks
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('');
          if (text) {
            finalText += text;
            socket.emit('message_chunk', { text });
          }
        }
        if (event.type === 'result') {
          newSessionId = (event as { session_id?: string }).session_id;
        }
      } catch { /* non-JSON 줄 무시 */ }
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    log(`claude stderr: ${data.toString().slice(0, 200)}`);
  });

  child.on('close', (code: number | null) => {
    activeProcs.delete(child);
    socket.emit('message_done', {
      content: finalText || '(출력 없음)',
      type: 'cli',
      ...(newSessionId ? { sessionId: newSessionId } : {}),
    });
    log(`executeClaude done: exit=${code}`);
  });

  child.on('error', (err: Error & { code?: string }) => {
    activeProcs.delete(child);
    const msg = err.code === 'ENOENT'
      ? '[오류] claude CLI가 설치되어 있지 않습니다. npm install -g @anthropic-ai/claude-code'
      : `[오류] ${err.message}`;
    socket.emit('message_done', { content: msg, type: 'cli' });
  });
}

// ── 메인 익스포트: startRelayPlugin ─────────────────────────────────────────

export interface RelayPluginResult {
  /** index.ts main() 에 전달할 ContainerInput */
  containerInput: ContainerInput;
  /** index.ts writeOutput() 에서 호출할 핸들러 (스트리밍 완료 시 message_done emit + DB 저장) */
  outputHandler: (output: ContainerOutput) => void;
  /** index.ts 스트리밍 루프에서 thinking 청크마다 호출 */
  thinkingHandler: (text: string) => void;
  /** index.ts 스트리밍 루프에서 텍스트 청크마다 호출 */
  chunkHandler: (text: string) => void;
  /** relay 재연결 후 다음 첫 메시지를 기다려 새 ContainerInput 반환 */
  waitForRestart: () => Promise<ContainerInput>;
}

/**
 * Relay Plugin을 시작합니다.
 *
 * - 최초 실행(AGENT_ID 없음): Relay Server에 등록 후 크리덴셜 저장
 * - RELAY_PAIR=1: 페어링 코드 생성 후 프로세스 종료
 * - 이후: 웹 UI의 첫 메시지를 기다렸다가 ContainerInput으로 반환
 */
export async function startRelayPlugin(): Promise<RelayPluginResult> {

  // ── 1. 크리덴셜 확인 / 최초 등록 ─────────────────────────────────────────
  let creds = loadCredentials();

  if (!creds) {
    log('AGENT_ID/TOKEN 없음 → Relay Server에 신규 등록 중...');
    const registered = await registerAgent();
    creds = { agentId: registered.agentId, token: registered.token };
    saveCredentials(creds);

    process.stderr.write('\n');
    process.stderr.write('✅ Agent 등록 완료!\n');
    process.stderr.write(`   AGENT_ID=${creds.agentId}\n`);
    process.stderr.write(`   AGENT_TOKEN=${creds.token}\n`);
    process.stderr.write('   환경 변수에 위 값을 저장하거나 컨테이너를 재시작하세요.\n\n');
  }

  // ── 2. 페어링 모드 (RELAY_PAIR=1) ─────────────────────────────────────────
  if (process.env.RELAY_PAIR === '1') {
    const minutes = parseInt(process.env.RELAY_PAIR_MINUTES || '10', 10);
    await generatePairingCode(creds.token, minutes);
    process.exit(0);
  }

  // ── 3. Socket.io 연결 ──────────────────────────────────────────────────────
  return new Promise<RelayPluginResult>((resolve, reject) => {

    const socket: Socket = io(RELAY_URL, {
      auth: { token: creds!.token },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
    });

    let firstMessageReceived = false;
    let pendingRestart: ((input: ContainerInput) => void) | null = null;
    let accumulatedThinking = '';
    const activeProcs: Set<ChildProcess> = new Set();

    const makeContainerInput = (prompt: string): ContainerInput => ({
      prompt,
      sessionId: undefined,
      groupFolder: '/workspace/group',
      chatJid: creds!.agentId,
      isMain: true,
      assistantName: AGENT_NAME,
      secrets: {
        ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN,
      },
    });

    /** thinking 청크를 Relay로 실시간 전달 */
    const thinkingHandler = (text: string): void => {
      accumulatedThinking += text;
      socket.emit('thinking_chunk', { text });
      log(`thinking_chunk 전송: ${text.length} chars`);
    };

    /** 텍스트 청크를 Relay로 실시간 전달 */
    const chunkHandler = (text: string): void => {
      socket.emit('message_chunk', { text });
      log(`message_chunk 전송: ${text.length} chars`);
    };

    /** writeOutput() 결과를 Relay로 전달 (message_done → 서버 DB 저장) */
    const outputHandler = (output: ContainerOutput): void => {
      if (output.result) {
        socket.emit('message_done', {
          content: output.result,
          thinking: accumulatedThinking || null,
          type: 'text',
        });
        log(`응답 전송: ${output.result.length} chars, thinking: ${accumulatedThinking.length} chars`);
        accumulatedThinking = '';
      }
    };

    /**
     * relay 재연결 후 다음 첫 메시지를 기다린다.
     * firstMessageReceived를 리셋하고, 다음 메시지가 오면 새 ContainerInput으로 resolve.
     */
    const waitForRestart = (): Promise<ContainerInput> => {
      firstMessageReceived = false;
      return new Promise<ContainerInput>(res => { pendingRestart = res; });
    };

    socket.on('connect', () => {
      log(`Relay 연결: ${RELAY_URL} (agentId: ${creds!.agentId})`);

      // 초기 heartbeat
      socket.emit('heartbeat', collectMetrics());

      // 30초 주기 heartbeat
      setInterval(() => {
        socket.emit('heartbeat', collectMetrics());
      }, 30_000);
    });

    socket.on('connect_error', (err) => {
      log(`Relay 연결 오류 (재시도 중...): ${err.message}`);
    });

    // ── 웹 UI → nanoclaw 메시지 수신 ─────────────────────────────────────────
    socket.on('message', (msg: { direction: string; type: string; content?: string }) => {
      if (msg.direction !== 'outbound' || msg.type !== 'text') return;

      const text = msg.content || '';

      // ── !sh 명령: shell 직접 실행 (Agent SDK 루프 우회) ──────────────────
      if (text.startsWith(SH_PREFIX)) {
        executeShell(text.slice(SH_PREFIX.length).trim(), socket, activeProcs);
        return;
      }

      // ── !cli 명령: claude CLI subprocess 실행 (Agent SDK 루프 우회) ──────
      if (text.startsWith(CLI_PREFIX)) {
        executeClaude(text.slice(CLI_PREFIX.length).trim(), socket, activeProcs);
        return;
      }

      // ── 일반 채팅: 기존 Agent SDK 루프 ───────────────────────────────────
      if (!firstMessageReceived) {
        // ── 첫 메시지 (또는 재연결 후 첫 메시지): 쿼리 시작 ─────────────────
        firstMessageReceived = true;
        log(`첫 메시지 수신 → 쿼리 시작: ${text.slice(0, 80)}`);

        const input = makeContainerInput(text);

        if (pendingRestart) {
          // waitForRestart()가 대기 중 → 새 쿼리 루프에 전달
          const cb = pendingRestart;
          pendingRestart = null;
          accumulatedThinking = '';
          cb(input);
        } else {
          // 최초 기동 → startRelayPlugin() Promise resolve
          resolve({ containerInput: input, outputHandler, thinkingHandler, chunkHandler, waitForRestart });
        }

      } else {
        // ── 이후 메시지: IPC 파일 방식으로 전달 ────────────────────────────
        writeIpcMessage(text);
      }
    });

    // ── 연결 끊김: 쿼리 루프 종료 + 실행 중인 프로세스 정리 ─────────────────
    socket.on('disconnect', (reason) => {
      log(`Relay 연결 끊김: ${reason}`);
      writeCloseSentinel();
      for (const proc of activeProcs) proc.kill('SIGKILL');
      activeProcs.clear();
    });

    // ── 새 친구 추가 알림 ─────────────────────────────────────────────────────
    socket.on('new_friend_added', (data: { userId?: string }) => {
      log(`새 친구 추가: userId=${data.userId}`);
    });
  });
}
