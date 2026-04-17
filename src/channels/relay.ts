/**
 * RelayChannel — nanoclaw 정식 채널 타입
 *
 * 이 파일을 nanoclaw/src/channels/relay.ts 로 복사하세요.
 *
 * 환경변수:
 *   RELAY_CHANNELS='[
 *     {"url":"https://relay.example.com","agentId":"abc123","token":"abc123:rawtoken","name":"Andy Web"},
 *     {"url":"https://relay2.example.com","agentId":"def456","token":"def456:rawtoken","name":"Andy Mirror"}
 *   ]'
 *
 * JID 형식: relay:{agentId}:{userId}
 */

import { io, Socket } from 'socket.io-client';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import { RELAY_CHANNELS } from '../config.js';

// ── relay 서버 메시지 타입 ────────────────────────────────────────────────────

interface RelayMessage {
  id: number;
  agent_id: string;
  user_id: number | null;
  conversation_id: number | null;
  direction: 'inbound' | 'outbound';
  type: string;
  content: string | null;
  user_name: string | null;
  created_at: string;
}

// ── 설정 타입 ─────────────────────────────────────────────────────────────────

interface RelayChannelConfig {
  url: string;
  agentId: string;
  token: string; // "agentId:rawToken" 형식
  name?: string;
  /** true면 웹 UI에서 메인 에이전트 배지를 표시 */
  isMain?: boolean;
}

// ── RelayChannel 구현 ─────────────────────────────────────────────────────────

export class RelayChannel implements Channel {
  readonly name = 'relay';

  private socket: Socket | null = null;
  private readonly agentId: string;
  private connectResolved = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** routingJid → latest conversation_id (for sendMessage target routing) */
  private conversationMap = new Map<string, number>();

  constructor(
    private readonly config: RelayChannelConfig,
    private readonly opts: ChannelOpts,
  ) {
    this.agentId = config.agentId;
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket = io(this.config.url, {
        auth: { token: this.config.token },
        reconnection: true,
        reconnectionDelay: 2_000,
        reconnectionDelayMax: 30_000,
      });

      // 서버가 콜드 스타트 등으로 늦게 응답할 경우 nanoclaw 기동을 블록하지 않도록
      // 15초 내 connect 이벤트가 없으면 경고 후 resolve하고 백그라운드에서 재연결 계속 시도
      const fallbackTimer = setTimeout(() => {
        if (!this.connectResolved) {
          this.connectResolved = true;
          logger.warn(
            { agentId: this.agentId, name: this.config.name },
            'RelayChannel connect timeout — starting in background, will reconnect',
          );
          resolve();
        }
      }, 15_000);

      this.socket.on('connect', () => {
        clearTimeout(fallbackTimer);
        logger.info(
          { agentId: this.agentId, name: this.config.name },
          'RelayChannel connected',
        );
        console.log(
          `\n  RelayChannel: ${this.config.name ?? this.agentId} connected`,
        );

        // relay 서버가 에이전트로부터 heartbeat 이벤트를 기대함
        // 30초마다 {cpu, mem} 페이로드로 전송하여 연결 유지
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = setInterval(() => {
          if (this.socket?.connected) {
            const mem = Math.round(
              process.memoryUsage().heapUsed / 1024 / 1024,
            );
            this.socket.emit('heartbeat', {
              cpu: 0,
              mem,
              isMain: this.config.isMain ?? false,
            });
            logger.debug(
              { agentId: this.agentId, mem },
              'RelayChannel heartbeat sent',
            );
          }
        }, 30_000);

        if (!this.connectResolved) {
          this.connectResolved = true;
          resolve();
        }
      });

      this.socket.on('connect_error', (err: Error) => {
        logger.warn(
          { agentId: this.agentId, err: err.message },
          'RelayChannel connect error — will retry',
        );
        // reject 하지 않음 — socket.io 재연결에 맡김
      });

      // relay 서버가 웹 유저 메시지를 push
      this.socket.on('message', (msg: RelayMessage) => {
        if (msg.direction !== 'outbound') return;

        // conversation_id 우선 (c{id} 접두사로 userId와 충돌 방지),
        // 없으면 user_id로 폴백 (하위 호환)
        const roomKey =
          msg.conversation_id != null
            ? `c${msg.conversation_id}`
            : msg.user_id != null
              ? String(msg.user_id)
              : null;
        if (!roomKey) return;

        const senderName = msg.user_name ?? `User ${msg.user_id ?? roomKey}`;
        let registered = this.opts.registeredGroups();

        let chatJid = `relay:${this.agentId}:${roomKey}`;

        // conversation JID가 미등록이고 userId JID가 등록된 경우:
        // onAutoRegister 콜백으로 conversation JID를 자동 등록한다.
        // 이후 모든 대화는 고유 JID로 라우팅되므로 레이스 컨디션 없음.
        if (
          !registered[chatJid] &&
          msg.conversation_id != null &&
          msg.user_id != null
        ) {
          const fallbackJid = `relay:${this.agentId}:${msg.user_id}`;

          // userId JID 자체가 미등록이고 isMain 채널이면 자동 등록 (최초 접속 사용자)
          if (!registered[fallbackJid] && this.config.isMain) {
            const safeName =
              senderName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() ||
              `user_${msg.user_id}`;
            const folder =
              safeName
                .toLowerCase()
                .replace(/[\s\-]+/g, '_')
                .replace(/[^a-z0-9_]/g, '')
                .slice(0, 32) || `relay_${msg.user_id}`;
            if (this.opts.onAutoRegisterNew) {
              // isMain 채널의 신규 유저 → isMain=true 로 등록
              this.opts.onAutoRegisterNew(
                fallbackJid,
                senderName,
                folder,
                this.config.isMain,
              );
              registered = this.opts.registeredGroups();
              logger.info(
                { fallbackJid, senderName, folder, isMain: this.config.isMain },
                'RelayChannel: new userId JID auto-registered',
              );
            }
          }

          // 기존 등록 유저가 isMain 채널에서 왔지만 DB에서 isMain=false인 경우 → 승격
          if (
            registered[fallbackJid] &&
            this.config.isMain &&
            !registered[fallbackJid].isMain
          ) {
            this.opts.onPromoteToMain?.(fallbackJid);
            registered = this.opts.registeredGroups();
            logger.info(
              { fallbackJid },
              'RelayChannel: promoted userId JID to main (matches channel isMain config)',
            );
          }

          if (registered[fallbackJid]) {
            if (this.opts.onAutoRegister) {
              this.opts.onAutoRegister(chatJid, fallbackJid);
              // Re-read after registration
              registered = this.opts.registeredGroups();
            }
            if (!registered[chatJid]) {
              // Auto-register failed or not supported — fall back
              logger.debug(
                { chatJid, fallbackJid },
                'RelayChannel: auto-register failed, falling back to userId JID',
              );
              chatJid = fallbackJid;
            } else {
              logger.info(
                { chatJid, fallbackJid },
                'RelayChannel: conversation JID auto-registered',
              );
            }
          }
        }

        this.opts.onChatMetadata(
          chatJid,
          msg.created_at,
          senderName,
          'relay',
          false,
        );

        if (!registered[chatJid]) {
          logger.debug(
            { chatJid },
            'RelayChannel: message from unregistered chat',
          );
          return;
        }

        // conversation_id를 conversationMap에 저장하여 sendMessage에서 사용
        if (msg.conversation_id != null) {
          this.conversationMap.set(chatJid, msg.conversation_id);

          // 메인 대화방 지정: this.config.isMain이 true인 채널에서만 emit.
          // registered_groups.is_main은 NanoClaw 라우팅 기준이고, relay 서버의
          // main conversation 지정은 RELAY_CHANNELS의 isMain 설정으로만 판단.
          // (relay 유저 JID는 onAutoRegisterNew에서 항상 isMain=false로 등록되므로
          //  registered[sourceJid]?.isMain 체크를 추가하면 절대 emit되지 않음)
          if (this.config.isMain && this.socket?.connected) {
            this.socket.emit('set_main_conversation', {
              conversation_id: msg.conversation_id,
            });
          }
        }

        this.opts.onMessage(chatJid, {
          id: String(msg.id),
          chat_jid: chatJid,
          sender: String(msg.user_id ?? roomKey),
          sender_name: senderName,
          content: msg.content ?? '',
          timestamp: msg.created_at,
          is_from_me: false,
        });

        logger.info(
          {
            chatJid,
            conversationId: msg.conversation_id,
            userId: msg.user_id,
            agentId: this.agentId,
          },
          'RelayChannel message stored',
        );
      });

      // 대화방 삭제 알림 — nanoclaw 그룹 자동 해제
      this.socket.on(
        'conversation_deleted',
        ({
          conversation_id,
          agent_id,
        }: {
          conversation_id: number;
          agent_id: string;
        }) => {
          const jid = `relay:${agent_id}:c${conversation_id}`;
          this.conversationMap.delete(jid);
          if (this.opts.onAutoUnregister) {
            this.opts.onAutoUnregister(jid);
            logger.info(
              { jid, conversation_id, agent_id },
              'RelayChannel: conversation deleted, group unregistered',
            );
          }
        },
      );

      this.socket.on('disconnect', (reason: string) => {
        if (this.keepaliveTimer) {
          clearInterval(this.keepaliveTimer);
          this.keepaliveTimer = null;
        }
        logger.warn(
          { agentId: this.agentId, reason },
          'RelayChannel disconnected',
        );
      });
    });
  }

  async sendThinkingChunk(jid: string, text: string): Promise<void> {
    if (!this.socket?.connected) return;
    this.socket.emit('thinking_chunk', { text });
    logger.debug(
      { jid, length: text.length, agentId: this.agentId },
      'RelayChannel thinking_chunk sent',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.socket?.connected) {
      logger.warn({ jid, agentId: this.agentId }, 'RelayChannel not connected');
      return;
    }

    const roomKey = jid.split(':')[2];
    if (!roomKey) {
      logger.warn({ jid }, 'RelayChannel: invalid JID format');
      return;
    }

    // c{id} 접두사면 conversation_id, 순수 숫자면 레거시 user_id
    // conversationMap에 저장된 값이 있으면 항상 conversation_id 우선 사용
    const convMatch = roomKey.match(/^c(\d+)$/);
    const mappedConvId = this.conversationMap.get(jid);
    const payload = convMatch
      ? {
          content: text,
          type: 'text',
          target_conversation_id: Number(convMatch[1]),
        }
      : mappedConvId != null
        ? { content: text, type: 'text', target_conversation_id: mappedConvId }
        : { content: text, type: 'text', target_user_id: roomKey };

    this.socket.emit('message_done', payload);

    logger.info(
      { jid, roomKey, length: text.length, agentId: this.agentId },
      'RelayChannel message sent',
    );
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`relay:${this.agentId}:`);
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  async disconnect(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.socket?.disconnect();
    this.socket = null;
    logger.info({ agentId: this.agentId }, 'RelayChannel stopped');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // relay 서버 typing 이벤트 미지원 — 추후 구현
  }

  // relay:agentId:cN JID는 대화별 IPC 격리가 필요 — conversation ID를 suffix로 반환
  getIpcFolderSuffix(chatJid: string): string | undefined {
    const m = chatJid.match(/^relay:.+:c(\d+)$/);
    return m ? m[1] : undefined;
  }
}

// ── 팩토리 등록 ───────────────────────────────────────────────────────────────

registerChannel('relay', (opts: ChannelOpts) => {
  const raw = RELAY_CHANNELS;
  if (!raw) {
    logger.debug('RelayChannel: RELAY_CHANNELS not set — skipping');
    return null;
  }

  let configs: RelayChannelConfig[];
  try {
    configs = JSON.parse(raw);
  } catch (e) {
    logger.error({ err: e }, 'RelayChannel: RELAY_CHANNELS JSON parse error');
    return null;
  }

  if (!Array.isArray(configs) || configs.length === 0) {
    logger.warn('RelayChannel: RELAY_CHANNELS must be a non-empty JSON array');
    return null;
  }

  logger.info(
    { count: configs.length, names: configs.map((c) => c.name ?? c.agentId) },
    'RelayChannel: creating instances',
  );

  // Channel[] 반환 — registry.ts ChannelFactory 타입 및 index.ts .flat() 처리 필요
  return configs.map((cfg) => new RelayChannel(cfg, opts));
});
