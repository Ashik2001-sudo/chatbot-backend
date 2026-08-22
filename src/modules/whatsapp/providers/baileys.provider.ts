import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import makeWASocket, {
  Browsers,
  Contact as WAContact,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  WASocket,
  WAMessage,
  downloadMediaMessage,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as QRCode from 'qrcode';
import { basename, join } from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ChannelService } from '../../channel/channel.service';
import { MessageService } from '../../message/message.service';

interface GroupInfo {
  subject: string;
  /** announce-only group where we are not an admin, so we can't send */
  readOnly: boolean;
}

interface HistoryChunk {
  messages: WAMessage[];
  progress?: number | null;
  isLatest?: boolean;
}

interface HistorySyncState {
  /** null = waiting for the admin's choice, true/false = decided */
  decision: boolean | null;
  buffered: HistoryChunk[];
  imported: number;
  queue: Promise<void>;
}

@Injectable()
export class BaileysProvider {
  private readonly logger = new Logger(BaileysProvider.name);
  private sessions = new Map<string, WASocket>();
  /** Channels shut down on purpose; suppresses the auto-reconnect. */
  private stopped = new Set<string>();
  /** QR pairing in progress — a 515 close must resume, not wipe or skip. */
  private freshPairings = new Set<string>();
  private resumeAttempts = new Map<string, number>();
  /** Reuse the WA Web version the QR was generated with. */
  private cachedWaVersion?: [number, number, number];
  private groupMetaCache = new Map<string, GroupInfo & { fetchedAt: number }>();
  private historyDecisionHandlers = new Map<
    string,
    (enabled: boolean) => Promise<void>
  >();
  /**
   * History sync progress per channel. Lives on the provider (not inside
   * startSession) because the socket restarts once right after pairing
   * (code 515) and the state must survive that restart.
   */
  private historyStates = new Map<string, HistorySyncState>();
  /**
   * Contact names per channel keyed by normalized jid (both lid and phone
   * forms). Filled from history sync and contact events; used to name group
   * senders whose messages carry no pushName (common in history sync).
   */
  private contactNames = new Map<string, Map<string, string>>();

  private rememberContacts(channelId: string, contacts: Partial<WAContact>[]) {
    let dir = this.contactNames.get(channelId);
    if (!dir) {
      dir = new Map();
      this.contactNames.set(channelId, dir);
    }
    for (const c of contacts) {
      const name = c.name ?? c.notify ?? c.verifiedName;
      if (!name) continue;
      for (const id of [c.id, c.lid, c.phoneNumber]) {
        if (id) dir.set(jidNormalizedUser(id), name);
      }
    }
  }

  /** Resolve a group message's author to a display name. */
  private async lookupSenderName(
    sock: WASocket,
    channelId: string,
    msg: WAMessage,
  ): Promise<string | undefined> {
    if (msg.pushName) return msg.pushName;

    const dir = this.contactNames.get(channelId);
    const candidates: string[] = [];
    for (const raw of [msg.key.participantAlt, msg.key.participant]) {
      if (!raw) continue;
      const jid = jidNormalizedUser(raw);
      candidates.push(jid);
      if (jid.endsWith('@lid')) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
          if (pn) candidates.push(jidNormalizedUser(pn));
        } catch {
          // no mapping known
        }
      }
    }

    for (const jid of candidates) {
      const name = dir?.get(jid);
      if (name) return name;
    }
    // No saved name: show the phone number, never a meaningless lid id.
    const pn = candidates.find((j) => j.endsWith('@s.whatsapp.net'));
    return pn ? pn.split('@')[0] : undefined;
  }

  private async getGroupInfo(
    sock: WASocket,
    jid: string,
  ): Promise<GroupInfo | undefined> {
    const cached = this.groupMetaCache.get(jid);
    if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);

      // In announce-only groups (incl. community announcement groups) only
      // admins can send, so check whether our own account is an admin.
      const selfJids = new Set(
        [sock.user?.id, sock.user?.lid]
          .filter((j): j is string => Boolean(j))
          .map((j) => jidNormalizedUser(j)),
      );
      const isSelfAdmin =
        meta.participants?.some(
          (p) => Boolean(p.admin) && selfJids.has(jidNormalizedUser(p.id)),
        ) ?? false;

      const info: GroupInfo = {
        subject: meta.subject,
        readOnly: Boolean(meta.announce) && !isSelfAdmin,
      };
      this.groupMetaCache.set(jid, { ...info, fetchedAt: Date.now() });
      return info;
    } catch {
      return undefined;
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly channelService: ChannelService,
  ) {}

  private getAuthDir(channelId: string) {
    const dir = join(process.cwd(), 'sessions', channelId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  hasSavedSession(channelId: string) {
    return existsSync(join(process.cwd(), 'sessions', channelId, 'creds.json'));
  }

  private disconnectStatusCode(
    lastDisconnect: { error?: Boom | Error } | undefined,
  ): number | undefined {
    const err = lastDisconnect?.error as
      | (Boom & { status?: number; data?: { attrs?: { code?: string } } })
      | undefined;
    const fromAttrs = Number(err?.data?.attrs?.code);
    return (
      err?.output?.statusCode ??
      err?.status ??
      (Number.isFinite(fromAttrs) ? fromAttrs : undefined)
    );
  }

  private isRestartRequired(
    statusCode: number | undefined,
    lastDisconnect: { error?: Boom | Error } | undefined,
  ) {
    if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
      return true;
    }
    const msg = lastDisconnect?.error?.message ?? '';
    return /restart required/i.test(msg);
  }

  private async resolveWaVersion() {
    if (this.cachedWaVersion) return this.cachedWaVersion;
    try {
      const waVersion = await fetchLatestWaWebVersion({});
      this.cachedWaVersion = waVersion.version;
      this.logger.log(`Using WhatsApp Web version v${waVersion.version.join('.')}`);
      return this.cachedWaVersion;
    } catch (err) {
      this.logger.warn(
        `Failed to fetch latest WhatsApp version: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  async setHistorySyncDecision(channelId: string, enabled: boolean) {
    const handler = this.historyDecisionHandlers.get(channelId);
    if (!handler) {
      throw new BadRequestException(
        'No pending history sync decision for this WhatsApp channel.',
      );
    }
    await handler(enabled);
  }

  private async saveInboundMedia(
    msg: Parameters<typeof downloadMediaMessage>[0],
    mimetype?: string,
  ): Promise<string | undefined> {
    try {
      const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
      const ext = mimetype?.split(';')[0]?.split('/')[1] ?? 'bin';
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
      const dir = join(process.cwd(), 'uploads');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await writeFile(join(dir, filename), buffer);
      return `/uploads/${filename}`;
    } catch (error) {
      this.logger.warn(
        `Failed to download media: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return undefined;
    }
  }

  async startSession(
    tenantId: string,
    channelId: string,
    onMessage: (data: Parameters<MessageService['createInbound']>[0]) => Promise<unknown>,
    opts: { allowPairing?: boolean; resume?: boolean } = {},
  ) {
    // Default false: a missing flag must never wipe a just-paired session.
    const allowPairing = opts.allowPairing ?? false;
    this.stopped.delete(channelId);

    if (allowPairing) {
      // Disconnect any existing session for this channel before creating a new socket
      this.disconnect(channelId);

      // Clean up old session files so Baileys is forced to generate a fresh QR code
      const dir = join(process.cwd(), 'sessions', channelId);
      if (existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          this.logger.warn(`Could not clear auth dir ${dir}: ${e}`);
        }
      }
    }

    const authDir = this.getAuthDir(channelId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    // creds.me is only set once QR pairing succeeded (creds.registered is
    // exclusively for phone-number link-code pairing, not QR).
    const isNewPairing = !state.creds.me;

    // Restoring an unpaired session would emit endless QR codes; only a
    // user-initiated connect is allowed to start the QR pairing flow.
    if (isNewPairing && !allowPairing) {
      if (opts.resume) {
        const attempt = (this.resumeAttempts.get(channelId) ?? 0) + 1;
        this.resumeAttempts.set(channelId, attempt);
        if (attempt <= 5) {
          this.logger.warn(
            `Resume after QR pairing for ${channelId} but creds.me not on disk yet (attempt ${attempt}/5)`,
          );
          setTimeout(
            () =>
              void this.startSession(tenantId, channelId, onMessage, {
                allowPairing: false,
                resume: true,
              }),
            1000,
          );
          return;
        }
        this.resumeAttempts.delete(channelId);
      }
      this.logger.warn(
        `Skipping unpaired session ${channelId} (no QR pairing requested, creds.json=${this.hasSavedSession(channelId)})`,
      );
      await this.channelService.updateStatus(channelId, 'disconnected');
      this.realtimeGateway.emitChannelStatus(tenantId, channelId, 'disconnected');
      return;
    }
    this.resumeAttempts.delete(channelId);

    if (isNewPairing) this.freshPairings.add(channelId);

    const version = await this.resolveWaVersion();

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu('Chrome'),
      auth: state,
      // Ask the phone for full chat history when the device is (re)linked.
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
    });

    this.sessions.set(channelId, sock);

    sock.ev.on('creds.update', saveCreds);

    // Address book names arrive separately from messages; keep a directory
    // so group senders can be named even when messages lack a pushName.
    sock.ev.on('contacts.upsert', (contacts) =>
      this.rememberContacts(channelId, contacts),
    );
    sock.ev.on('contacts.update', (contacts) =>
      this.rememberContacts(channelId, contacts),
    );

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        this.realtimeGateway.emitWhatsAppQr(tenantId, channelId, qrDataUrl);
        await this.channelService.updateStatus(channelId, 'pending_qr');
      }

      if (connection === 'open') {
        this.freshPairings.delete(channelId);
        this.resumeAttempts.delete(channelId);
        await this.channelService.updateStatus(channelId, 'connected');
        this.realtimeGateway.emitChannelStatus(tenantId, channelId, 'connected');
        this.logger.log(
          `Baileys connected: ${channelId} as ${sock.user?.id ?? sock.authState.creds.me?.id}`,
        );
        await this.backfillContactAvatars(channelId, sock);
      }

      if (connection === 'close') {
        this.sessions.delete(channelId);
        // Intentional shutdown (channel deleted/disconnected by the admin):
        // skip the status update and never reconnect.
        if (this.stopped.delete(channelId)) {
          this.freshPairings.delete(channelId);
          return;
        }

        const statusCode = this.disconnectStatusCode(lastDisconnect);
        const paired = Boolean(sock.authState.creds.me);
        const restartNeeded =
          this.isRestartRequired(statusCode, lastDisconnect) ||
          (paired &&
            this.freshPairings.has(channelId) &&
            statusCode !== DisconnectReason.loggedOut);

        this.logger.log(
          `Baileys closed ${channelId} (code ${statusCode ?? 'unknown'}: ${lastDisconnect?.error?.message ?? 'no error'}, paired=${paired}, restart=${restartNeeded})`,
        );

        // 515 after a QR scan is WhatsApp telling us to reopen with the
        // new credentials. Flush creds first and never wipe the session.
        if (restartNeeded) {
          try {
            await saveCreds();
          } catch (e) {
            this.logger.warn(
              `Could not flush creds before restart: ${e instanceof Error ? e.message : e}`,
            );
          }
          this.logger.log(
            `Restarting session ${channelId} to finish login (me=${sock.authState.creds.me?.id ?? 'pending'})`,
          );
          setTimeout(
            () =>
              void this.startSession(tenantId, channelId, onMessage, {
                allowPairing: false,
                resume: true,
              }),
            500,
          );
          return;
        }

        this.freshPairings.delete(channelId);

        // Only paired sessions may auto-reconnect. An unpaired session
        // closing means the QR was never scanned (timeout) — restarting it
        // would emit fresh QR codes in an endless loop.
        const shouldReconnect =
          paired && statusCode !== DisconnectReason.loggedOut;
        await this.channelService.updateStatus(channelId, 'disconnected');
        this.realtimeGateway.emitChannelStatus(tenantId, channelId, 'disconnected');
        if (shouldReconnect) {
          setTimeout(
            () =>
              void this.startSession(tenantId, channelId, onMessage, {
                allowPairing: false,
              }),
            5000,
          );
        } else if (!paired) {
          this.logger.log(
            `QR pairing for ${channelId} expired without a scan; stopping.`,
          );
        } else {
          // WhatsApp invalidated this session (unlinked / conflict). The
          // saved credentials are dead; wipe them so restarts don't retry
          // them forever. Reconnecting requires a fresh QR scan.
          this.logger.warn(
            `Session ${channelId} was logged out by WhatsApp; clearing saved credentials.`,
          );
          const dir = join(process.cwd(), 'sessions', channelId);
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const channel = await this.channelService.findById(tenantId, channelId);

      for (const msg of messages) {
        const payload = await this.buildInboundPayload(
          sock,
          tenantId,
          channelId,
          channel.type,
          msg,
          { history: false },
        );
        if (payload) await onMessage(payload);
      }
    });

    // Chat history can start arriving immediately after the QR is accepted.
    // Buffer it until the admin chooses whether it should be imported. Only
    // a fresh pairing resets the state; the post-pairing restart (code 515)
    // reuses the state and handler that the QR session created.
    if (isNewPairing) {
      this.historyStates.set(channelId, {
        decision: null,
        buffered: [],
        imported: 0,
        queue: Promise.resolve(),
      });

      const decisionTimeout = setTimeout(() => {
        const handler = this.historyDecisionHandlers.get(channelId);
        if (handler) void handler(false);
      }, 5 * 60_000);

      this.historyDecisionHandlers.set(channelId, async (enabled) => {
        clearTimeout(decisionTimeout);
        this.historyDecisionHandlers.delete(channelId);
        const state = this.historyStates.get(channelId);
        if (!state) return;
        state.decision = enabled;

        if (!enabled) {
          state.buffered = [];
          this.realtimeGateway.emitHistorySyncProgress(tenantId, {
            channelId,
            progress: 100,
            imported: 0,
            done: true,
          });
          return;
        }

        const chunks = state.buffered.splice(0);
        state.queue = state.queue.then(async () => {
          for (const chunk of chunks) {
            await this.processHistoryChunk(tenantId, channelId, onMessage, chunk);
          }
        });
        await state.queue;
      });
    }

    sock.ev.on(
      'messaging-history.set',
      async ({ messages, progress, isLatest, contacts }) => {
        // Names are always worth remembering, even when history is skipped.
        if (contacts?.length) this.rememberContacts(channelId, contacts);

        const state = this.historyStates.get(channelId);
        if (!state || state.decision === false) return;

        const chunk = { messages, progress, isLatest };
        if (state.decision === null) {
          state.buffered.push(chunk);
          return;
        }

        state.queue = state.queue.then(() =>
          this.processHistoryChunk(tenantId, channelId, onMessage, chunk),
        );
        await state.queue;
      },
    );
  }

  private async processHistoryChunk(
    tenantId: string,
    channelId: string,
    onMessage: (data: Parameters<MessageService['createInbound']>[0]) => Promise<unknown>,
    chunk: HistoryChunk,
  ) {
    if (!chunk.messages.length) return;
    const state = this.historyStates.get(channelId);
    // Always resolve the *current* socket: chunks may be processed after the
    // post-pairing restart replaced the socket that buffered them.
    const sock = this.sessions.get(channelId);
    if (!state || !sock) return;

    const channel = await this.channelService.findById(tenantId, channelId);
    this.logger.log(
      `History chunk for ${channelId}: ${chunk.messages.length} messages (progress ${chunk.progress ?? '?'}%)`,
    );

    for (const msg of chunk.messages) {
      try {
        const payload = await this.buildInboundPayload(
          sock,
          tenantId,
          channelId,
          channel.type,
          msg,
          { history: true },
        );
        if (!payload) continue;
        const result = await onMessage(payload);
        if (result) state.imported++;
      } catch (error) {
        this.logger.warn(
          `Skipping history message: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    this.realtimeGateway.emitHistorySyncProgress(tenantId, {
      channelId,
      progress: typeof chunk.progress === 'number' ? chunk.progress : null,
      imported: state.imported,
      done:
        Boolean(chunk.isLatest) ||
        (typeof chunk.progress === 'number' && chunk.progress >= 100),
    });
  }

  /**
   * Turns a raw Baileys message into a createInbound payload. Used by both
   * live upserts and history sync; history skips media download and avatar
   * fetches to keep the bulk import fast.
   */
  private async buildInboundPayload(
    sock: WASocket,
    tenantId: string,
    channelId: string,
    channelType: Parameters<MessageService['createInbound']>[0]['channelType'],
    msg: WAMessage,
    opts: { history: boolean },
  ): Promise<Parameters<MessageService['createInbound']>[0] | null> {
    if (!msg.message) return null;

    const rawJid = msg.key.remoteJid ?? '';
    // Status updates and channels/newsletters don't belong in the inbox.
    if (rawJid === 'status@broadcast' || rawJid.endsWith('@newsletter')) {
      return null;
    }

    // fromMe = the business replied from another device (e.g. phone);
    // record it as outbound instead of dropping it.
    const fromMe = Boolean(msg.key.fromMe);
    const isGroup = rawJid.endsWith('@g.us');

    let jid = isGroup ? rawJid : (msg.key.remoteJidAlt ?? rawJid);
    // WhatsApp increasingly addresses chats by anonymous "@lid" ids; map
    // them back to the real phone-number JID so contacts don't duplicate.
    if (!isGroup && jid.endsWith('@lid')) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) jid = pn;
      } catch {
        // no mapping known yet; fall through with the lid jid
      }
    }
    if (!isGroup) jid = jidNormalizedUser(jid);
    // Groups keep the full JID so replies route back to the group.
    const phone = isGroup
      ? rawJid
      : jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

    // Unresolvable lid-only chats would show up as meaningless numeric ids
    // in the inbox; skip them (they re-arrive resolved once the mapping is
    // known).
    if (!isGroup && jid.endsWith('@lid')) return null;

    const senderName =
      isGroup && !fromMe
        ? await this.lookupSenderName(sock, channelId, msg)
        : undefined;

    // Group conversations are named after the group; individual chats
    // after the sender. pushName on fromMe messages is our own name.
    let name: string | undefined;
    let readOnly: boolean | undefined;
    if (isGroup) {
      const groupInfo = await this.getGroupInfo(sock, rawJid);
      name = groupInfo?.subject;
      readOnly = groupInfo?.readOnly;
    } else if (!fromMe) {
      name = msg.pushName ?? phone;
    }

    let avatarUrl: string | undefined;
    if (!opts.history) {
      try {
        avatarUrl = await sock.profilePictureUrl(
          isGroup ? rawJid : jidNormalizedUser(jid),
          'preview',
          10_000,
        );
      } catch {
        // no profile picture or privacy settings block it
      }
    }

    let body = '';
    let contentType: 'text' | 'image' | 'audio' | 'document' | 'video' = 'text';
    let mediaUrl: string | undefined;

    // Media in history sync is usually expired on WhatsApp servers, so old
    // messages keep their caption/placeholder without downloading the file.
    const downloadMedia = !opts.history;

    if (msg.message.conversation) {
      body = msg.message.conversation;
    } else if (msg.message.extendedTextMessage?.text) {
      body = msg.message.extendedTextMessage.text;
    } else if (msg.message.imageMessage) {
      contentType = 'image';
      body = msg.message.imageMessage.caption ?? '';
      if (downloadMedia) {
        mediaUrl = await this.saveInboundMedia(
          msg,
          msg.message.imageMessage.mimetype ?? 'image/jpeg',
        );
      } else if (!body) {
        body = '[Photo]';
      }
    } else if (msg.message.videoMessage) {
      contentType = 'video';
      body = msg.message.videoMessage.caption ?? '';
      if (downloadMedia) {
        mediaUrl = await this.saveInboundMedia(
          msg,
          msg.message.videoMessage.mimetype ?? 'video/mp4',
        );
      } else if (!body) {
        body = '[Video]';
      }
    } else if (msg.message.audioMessage) {
      contentType = 'audio';
      if (downloadMedia) {
        mediaUrl = await this.saveInboundMedia(
          msg,
          msg.message.audioMessage.mimetype ?? 'audio/ogg',
        );
      } else {
        body = '[Audio]';
      }
    } else if (msg.message.documentMessage) {
      contentType = 'document';
      body = msg.message.documentMessage.fileName ?? '';
      if (downloadMedia) {
        mediaUrl = await this.saveInboundMedia(
          msg,
          msg.message.documentMessage.mimetype ?? 'application/octet-stream',
        );
      }
    } else if (msg.message.stickerMessage) {
      contentType = 'image';
      body = '';
      if (downloadMedia) {
        mediaUrl = await this.saveInboundMedia(msg, 'image/webp');
      } else {
        body = '[Sticker]';
      }
    } else if (opts.history) {
      // Protocol/system messages in history carry no displayable content.
      return null;
    }

    // In groups, prefix who wrote it (there's no per-message sender field).
    // Skipped when the author couldn't be resolved to a name or number.
    if (isGroup && !fromMe && senderName && contentType !== 'document') {
      body = body ? `${senderName}: ${body}` : `${senderName}:`;
    }

    const timestampSec = Number(msg.messageTimestamp ?? 0);

    return {
      tenantId,
      channelConnId: channelId,
      channelType,
      direction: fromMe ? 'outbound' : 'inbound',
      history: opts.history,
      conversationMeta: { readOnly },
      contact: {
        name,
        phone,
        avatarUrl,
        externalIds: { whatsapp: phone },
      },
      message: {
        body,
        contentType,
        mediaUrl,
        externalId: msg.key.id ?? undefined,
        timestamp:
          opts.history && timestampSec
            ? new Date(timestampSec * 1000)
            : undefined,
      },
    };
  }

  private async backfillContactAvatars(channelId: string, sock: WASocket) {
    const conversations = await this.prisma.conversation.findMany({
      where: { channelConnId: channelId },
      select: {
        contact: {
          select: { id: true, phone: true, avatarUrl: true },
        },
      },
    });

    for (const { contact } of conversations) {
      if (contact.avatarUrl || !contact.phone) continue;

      let jid = contact.phone.includes('@')
        ? contact.phone
        : contact.phone.startsWith('120363')
          ? `${contact.phone}@g.us`
          : `${contact.phone.replace(/\D/g, '')}@s.whatsapp.net`;

      try {
        if (jid.endsWith('@lid')) {
          jid =
            (await sock.signalRepository.lidMapping.getPNForLID(jid)) ?? jid;
        }
        jid = jidNormalizedUser(jid);
        const avatarUrl = await sock.profilePictureUrl(jid, 'preview', 10_000);
        if (avatarUrl) {
          await this.prisma.contact.update({
            where: { id: contact.id },
            data: { avatarUrl },
          });
          this.logger.log(`Saved profile picture for ${jid}`);
        }
      } catch (error) {
        this.logger.warn(
          `Profile picture unavailable for ${jid}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  async sendMessage(
    channelId: string,
    phone: string,
    body: string,
    mediaUrl?: string,
    contentType?: string,
  ) {
    const sock = this.sessions.get(channelId);
    if (!sock) {
      throw new BadRequestException(
        'WhatsApp session is not connected. Please reconnect the channel from the Channels page.',
      );
    }

    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    if (!mediaUrl) {
      await sock.sendMessage(jid, { text: body });
      return;
    }

    // Locally uploaded files live under /uploads; Baileys can read them from disk.
    const source = mediaUrl.startsWith('/uploads')
      ? join(process.cwd(), mediaUrl.replace(/^\//, ''))
      : mediaUrl;

    if (contentType === 'video') {
      await sock.sendMessage(jid, {
        video: { url: source },
        caption: body || undefined,
      });
    } else if (contentType === 'audio') {
      // Browser-recorded voice notes are opus (webm/ogg); WhatsApp plays
      // them as proper voice messages when flagged as ptt with an opus
      // mimetype. Other audio files go out as regular audio.
      const isVoiceNote = /\.(webm|ogg|opus)$/i.test(source);
      await sock.sendMessage(jid, {
        audio: { url: source },
        ptt: isVoiceNote,
        mimetype: isVoiceNote ? 'audio/ogg; codecs=opus' : 'audio/mp4',
      });
    } else if (contentType === 'document') {
      await sock.sendMessage(jid, {
        document: { url: source },
        fileName: body || basename(source),
        mimetype: 'application/octet-stream',
      });
    } else {
      await sock.sendMessage(jid, {
        image: { url: source },
        caption: body || undefined,
      });
    }
  }

  disconnect(channelId: string) {
    // Mark as intentionally stopped so the close handler doesn't reconnect.
    this.stopped.add(channelId);
    this.freshPairings.delete(channelId);
    this.resumeAttempts.delete(channelId);
    const sock = this.sessions.get(channelId);
    this.historyDecisionHandlers.delete(channelId);
    this.historyStates.delete(channelId);
    this.contactNames.delete(channelId);
    if (sock) {
      sock.end(undefined);
      this.sessions.delete(channelId);
    }
  }

  /** Disconnect and wipe stored credentials (for deleted channels). */
  removeSession(channelId: string) {
    this.disconnect(channelId);
    const dir = join(process.cwd(), 'sessions', channelId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
